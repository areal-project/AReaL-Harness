use super::*;
use image::{AnimationDecoder, GenericImageView, ImageDecoder};
use std::io::{Cursor, Seek, Write};

const MAX_PIXELS: u64 = 32 * 1024 * 1024;
const MAX_VIEW_BYTES: usize = 1024 * 1024;
const MAX_GIF_FRAMES: usize = 4096;
const MAX_ANIMATION_PIXELS: u64 = 512 * 1024 * 1024;

fn invalid(error: impl std::fmt::Display) -> rt::Error {
    let mut error = rt::Error::new(rt::ErrorCode::InvalidArgument, error.to_string());
    error.details = Some(json!({"reason":"MEDIA_PREPROCESS_FAILED"}));
    error
}

pub(super) async fn read(
    engine: &Engine,
    runtime: &RuntimeConfig,
    scope: &str,
    args: &Value,
) -> rt::Result<(bool, Value)> {
    let path = resource_uri(
        args["path"]
            .as_str()
            .ok_or_else(|| invalid("path required"))?,
        runtime,
    )
    .map_err(invalid)?;
    let facts = runtime
        .client
        .filesystem(rt::FileRequest {
            operation_id: runtime.client.operation_id(),
            scope_id: scope.into(),
            command: rt::FileCommand::Stat { path: path.clone() },
        })
        .await?;
    if facts["size"]
        .as_u64()
        .is_some_and(|n| n > rt::MAX_EDIT_FILE as u64)
    {
        let mut error = rt::Error::new(
            rt::ErrorCode::ResourceExhausted,
            "image source exceeds 8 MiB; use a local command to extract a bounded view",
        );
        error.details = Some(
            json!({"reason":"TOOL_SOURCE_LIMIT_EXCEEDED","actualBytes":facts["size"],"maxBytes":rt::MAX_EDIT_FILE}),
        );
        return Err(error);
    }
    let mut bytes = Vec::new();
    let mut original_hash = Value::Null;
    loop {
        let part = runtime
            .client
            .filesystem(rt::FileRequest {
                operation_id: runtime.client.operation_id(),
                scope_id: scope.into(),
                command: rt::FileCommand::Read {
                    path: path.clone(),
                    offset: bytes.len() as u64,
                    max_bytes: rt::MAX_FILE_CHUNK,
                },
            })
            .await?;
        if bytes.is_empty() {
            original_hash = part["sha256"].clone();
        }
        if part["sha256"] != original_hash {
            return Err(invalid(
                "image changed during read; retry from a fresh file",
            ));
        }
        let chunk = STANDARD
            .decode(
                part["dataBase64"]
                    .as_str()
                    .ok_or_else(|| invalid("missing image data"))?,
            )
            .map_err(invalid)?;
        if chunk.is_empty() && part["eof"] != true {
            return Err(invalid("image read did not advance"));
        }
        bytes.extend(chunk);
        if bytes.len() > rt::MAX_EDIT_FILE {
            return Err(invalid(
                "TOOL_SOURCE_LIMIT_EXCEEDED: image exceeds 8 MiB; derive a bounded view with a local command",
            ));
        }
        if part["eof"] == true {
            break;
        }
    }
    let source_bytes = bytes.len();
    let args = args.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare_media(bytes, &args))
        .await
        .map_err(invalid)??;
    let mut items = Vec::new();
    let mut views = Vec::new();
    for (coverage, prepared) in prepared.views {
        let output_bytes = prepared.png.len();
        let media = engine
            .store
            .save_blob("image/png".into(), prepared.png)
            .await
            .map_err(invalid)?;
        views.push(json!({"coverage":coverage,"sourceDimensions":prepared.source_size,"outputDimensions":prepared.output_size,"outputBytes":output_bytes,"media":media}));
        items.push(json!({"type":"arealMedia","modality":"image","media":media}));
    }
    let mut metadata = json!({"path":path,"sourceSha256":original_hash,"sourceBytes":source_bytes,"animation":prepared.animation,"crop":prepared.crop,"strategy":"lossless-png-bounded-preview","maxViewBytes":MAX_VIEW_BYTES,"views":views});
    // 保留原有单图字段；GIF 的逐视图信息在 views 中完整提供。
    for field in ["sourceDimensions", "outputDimensions", "media"] {
        metadata[field] = metadata["views"][0][field].clone();
    }
    items.insert(0, json!({"type":"inputText","text":metadata.to_string()}));
    Ok((true, json!({"contentItems":items})))
}

struct PreparedImage {
    png: Vec<u8>,
    source_size: (u32, u32),
    output_size: (u32, u32),
}
struct PreparedMedia {
    views: Vec<(Value, PreparedImage)>,
    animation: Option<Value>,
    crop: Option<Value>,
}

fn dimensions(size: (u32, u32)) -> rt::Result<()> {
    if size.0 == 0 || size.1 == 0 || u64::from(size.0) * u64::from(size.1) > MAX_PIXELS {
        return Err(invalid("image dimensions exceed 32 megapixels"));
    }
    Ok(())
}
fn limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits
}
fn gif(bytes: &[u8]) -> rt::Result<image::codecs::gif::GifDecoder<Cursor<&[u8]>>> {
    let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(invalid)?;
    dimensions(decoder.dimensions())?;
    decoder.set_limits(limits()).map_err(invalid)?;
    Ok(decoder)
}
fn prepare_media(bytes: Vec<u8>, args: &Value) -> rt::Result<PreparedMedia> {
    let dimension = args["maxDimension"].as_u64().unwrap_or(2048);
    if !(64..=4096).contains(&dimension) {
        return Err(invalid("maxDimension must be 64..4096"));
    }
    let crop = args.get("crop").cloned();
    if image::guess_format(&bytes).map_err(invalid)? != image::ImageFormat::Gif {
        if args.get("frameIndex").is_some() || args.get("timeMs").is_some() {
            return Err(invalid("frameIndex/timeMs require a GIF"));
        }
        return Ok(PreparedMedia {
            views: vec![(Value::Null, prepare(bytes, crop.clone(), dimension as u32)?)],
            animation: None,
            crop,
        });
    }
    let decoder = gif(&bytes)?;
    let size = decoder.dimensions();
    let pixels = u64::from(size.0) * u64::from(size.1);
    let mut timeline = Vec::new();
    let mut elapsed = 0.0;
    // 流式合成 disposal；不 collect 全动画，且限制累计解码工作量。
    for frame in decoder.into_frames() {
        if timeline.len() >= MAX_GIF_FRAMES
            || (timeline.len() as u64 + 1) * pixels > MAX_ANIMATION_PIXELS
        {
            return Err(invalid(
                "GIF exceeds frame/decode work budget; use a local command to extract a bounded interval",
            ));
        }
        let frame = frame.map_err(invalid)?;
        let (num, den) = frame.delay().numer_denom_ms();
        let delay = f64::from(num) / f64::from(den);
        timeline.push((elapsed, delay));
        elapsed += delay;
    }
    if timeline.is_empty() {
        return Err(invalid("GIF contains no frames"));
    }
    if args.get("frameIndex").is_some() && args.get("timeMs").is_some() {
        return Err(invalid("choose frameIndex or timeMs"));
    }
    let mut indices = if let Some(frame) = args.get("frameIndex") {
        vec![
            frame
                .as_u64()
                .filter(|i| *i < timeline.len() as u64)
                .ok_or_else(|| invalid("frameIndex is outside GIF; use a zero-based index"))?
                as usize,
        ]
    } else if let Some(time) = args.get("timeMs") {
        let time = time
            .as_f64()
            .filter(|t| *t >= 0.0 && *t < elapsed)
            .ok_or_else(|| invalid("timeMs is outside GIF duration"))?;
        vec![
            timeline
                .iter()
                .position(|(start, delay)| time < start + delay)
                .ok_or_else(|| invalid("GIF time has no frame"))?,
        ]
    } else {
        vec![0, timeline.len() / 2, timeline.len() - 1]
    };
    indices.sort_unstable();
    indices.dedup();
    let mut views = Vec::new();
    for (index, frame) in gif(&bytes)?.into_frames().enumerate() {
        if indices.binary_search(&index).is_ok() {
            let frame = frame.map_err(invalid)?;
            let view = render(
                image::DynamicImage::ImageRgba8(frame.into_buffer()),
                crop.clone(),
                dimension as u32,
            )?;
            views.push((json!({"frameIndex":index,"timeMs":timeline[index].0,"durationMs":timeline[index].1}), view));
        } else {
            frame.map_err(invalid)?;
        }
        if views.len() == indices.len() {
            break;
        }
    }
    Ok(PreparedMedia {
        views,
        animation: Some(
            json!({"frameCount":timeline.len(),"durationMs":elapsed,"sampled":indices.len()!=timeline.len(),"selectedFrames":indices,"readMore":"Use frameIndex (zero-based) or timeMs; previews do not cover every frame."}),
        ),
        crop,
    })
}

fn prepare(bytes: Vec<u8>, crop: Option<Value>, dimension: u32) -> rt::Result<PreparedImage> {
    let mut reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(invalid)?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP)
    ) {
        return Err(invalid("image_read supports PNG, JPEG, WebP and GIF"));
    }
    reader.limits(limits());
    let size = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(invalid)?
        .into_dimensions()
        .map_err(invalid)?;
    dimensions(size)?;
    render(reader.decode().map_err(invalid)?, crop, dimension)
}

struct BoundedPng {
    data: Cursor<Vec<u8>>,
    exceeded: bool,
}
impl Write for BoundedPng {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.data.position().saturating_add(bytes.len() as u64) > MAX_VIEW_BYTES as u64 {
            self.exceeded = true;
            return Err(std::io::Error::other("PNG view exceeds byte limit"));
        }
        self.data.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Seek for BoundedPng {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.data.seek(pos)
    }
}
fn render(
    mut decoded: image::DynamicImage,
    crop: Option<Value>,
    dimension: u32,
) -> rt::Result<PreparedImage> {
    let size = decoded.dimensions();
    dimensions(size)?;
    if let Some(crop) = crop {
        let n = |key| {
            crop[key]
                .as_u64()
                .ok_or_else(|| invalid("invalid image crop"))
        };
        let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
        if w == 0
            || h == 0
            || x.checked_add(w).is_none_or(|v| v > u64::from(size.0))
            || y.checked_add(h).is_none_or(|v| v > u64::from(size.1))
        {
            return Err(invalid("crop is outside the source image"));
        }
        decoded = decoded.crop_imm(x as u32, y as u32, w as u32, h as u32);
    }
    let mut scaled = if decoded.width() > dimension || decoded.height() > dimension {
        decoded.thumbnail(dimension, dimension)
    } else {
        decoded
    };
    loop {
        let mut output = BoundedPng {
            data: Cursor::new(Vec::new()),
            exceeded: false,
        };
        match scaled.write_to(&mut output, image::ImageFormat::Png) {
            Ok(()) => {
                return Ok(PreparedImage {
                    png: output.data.into_inner(),
                    source_size: size,
                    output_size: scaled.dimensions(),
                });
            }
            Err(_) if output.exceeded && scaled.width().max(scaled.height()) > 64 => {
                let next = (scaled.width().max(scaled.height()) / 2).max(64);
                scaled = scaled.thumbnail(next, next);
            }
            Err(error) => return Err(invalid(error)),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_resize_and_reject_outside_pixels() {
        let image = image::RgbImage::from_pixel(100, 50, image::Rgb([255, 0, 0]));
        let mut source = Cursor::new(Vec::new());
        image
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let bytes = source.into_inner();
        assert_eq!(
            prepare(bytes.clone(), None, 2048).unwrap().output_size,
            (100, 50)
        );
        let PreparedImage {
            png,
            source_size: original,
            output_size: scaled,
        } = prepare(
            bytes.clone(),
            Some(json!({"x":10,"y":10,"width":40,"height":20})),
            16,
        )
        .unwrap();
        assert_eq!(original, (100, 50));
        assert_eq!(scaled, (16, 8));
        assert_eq!(
            image::load_from_memory(&png)
                .unwrap()
                .to_rgb8()
                .get_pixel(0, 0)
                .0,
            [255, 0, 0]
        );
        assert!(prepare(bytes, Some(json!({"x":99,"y":0,"width":2,"height":1})), 16).is_err());
        assert!(prepare(b"not an image".to_vec(), None, 16).is_err());
    }
    fn animation_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = gif::Encoder::new(
                &mut bytes,
                4,
                1,
                &[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
            )
            .unwrap();
            for (left, pixels, delay, dispose) in [
                (0, vec![1, 1, 1, 1], 2, gif::DisposalMethod::Keep),
                (1, vec![3], 1, gif::DisposalMethod::Previous),
                (2, vec![2], 3, gif::DisposalMethod::Background),
                (3, vec![3], 4, gif::DisposalMethod::Keep),
            ] {
                let frame = gif::Frame {
                    left,
                    top: 0,
                    width: pixels.len() as u16,
                    height: 1,
                    delay,
                    dispose,
                    buffer: pixels.into(),
                    ..Default::default()
                };
                encoder.write_frame(&frame).unwrap();
            }
        }
        bytes
    }
    #[test]
    fn gif_sampling_timing_and_disposal_preserve_transient_frames() {
        let bytes = animation_fixture();
        let preview = prepare_media(bytes.clone(), &json!({})).unwrap();
        assert_eq!(preview.animation.as_ref().unwrap()["frameCount"], 4);
        assert_eq!(preview.animation.as_ref().unwrap()["durationMs"], 100.0);
        assert_eq!(
            preview.animation.as_ref().unwrap()["selectedFrames"],
            json!([0, 2, 3])
        );
        let decode = |view: &PreparedImage| image::load_from_memory(&view.png).unwrap().to_rgba8();
        assert_eq!(
            decode(&preview.views[1].1).get_pixel(1, 0).0,
            [255, 0, 0, 255]
        );
        assert_eq!(
            decode(&preview.views[1].1).get_pixel(2, 0).0,
            [0, 255, 0, 255]
        );
        assert_eq!(decode(&preview.views[2].1).get_pixel(2, 0).0, [0, 0, 0, 0]);
        for args in [json!({"frameIndex":1}), json!({"timeMs":20})] {
            let transient = prepare_media(bytes.clone(), &args).unwrap();
            assert_eq!(transient.views[0].0["timeMs"], 20.0);
            assert_eq!(
                decode(&transient.views[0].1).get_pixel(1, 0).0,
                [0, 0, 255, 255]
            );
        }
        for args in [
            json!({"frameIndex":4}),
            json!({"timeMs":100}),
            json!({"frameIndex":0,"timeMs":0}),
            json!({"maxDimension":0}),
        ] {
            assert!(prepare_media(bytes.clone(), &args).is_err());
        }
    }
    #[test]
    fn noisy_png_encoding_is_bounded_and_records_reduction() {
        let mut random = 42u32;
        let image = image::RgbImage::from_fn(1024, 1024, |_, _| {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            image::Rgb([random as u8, (random >> 8) as u8, (random >> 16) as u8])
        });
        let view = render(image::DynamicImage::ImageRgb8(image), None, 2048).unwrap();
        assert!(view.png.len() <= MAX_VIEW_BYTES);
        assert_eq!(view.source_size, (1024, 1024));
        assert!(view.output_size.0 < 1024);
    }
}
