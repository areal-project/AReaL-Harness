use super::*;
use image::GenericImageView;
use std::io::Cursor;

fn invalid(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::InvalidArgument, error.to_string())
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
            return Err(invalid("image exceeds 8 MiB"));
        }
        if part["eof"] == true {
            break;
        }
    }
    let source_bytes = bytes.len();
    let crop = args.get("crop").cloned();
    let dimension = args["maxDimension"].as_u64().unwrap_or(2048) as u32;
    let prepared = tokio::task::spawn_blocking(move || prepare(bytes, crop, dimension))
        .await
        .map_err(invalid)??;
    let media = engine
        .store
        .save_blob("image/png".into(), prepared.png)
        .await
        .map_err(invalid)?;
    let metadata = json!({"path":path,"sourceSha256":original_hash,"sourceBytes":source_bytes,"sourceDimensions":prepared.source_size,"outputDimensions":prepared.output_size,"media":media});
    Ok((
        true,
        json!({"contentItems":[{"type":"inputText","text":metadata.to_string()},{"type":"arealMedia","modality":"image","media":media}]}),
    ))
}

struct PreparedImage {
    png: Vec<u8>,
    source_size: (u32, u32),
    output_size: (u32, u32),
}

fn prepare(bytes: Vec<u8>, crop: Option<Value>, dimension: u32) -> rt::Result<PreparedImage> {
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(invalid)?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP)
    ) {
        return Err(invalid("image_read supports PNG, JPEG and WebP"));
    }
    let size = reader.into_dimensions().map_err(invalid)?;
    if u64::from(size.0) * u64::from(size.1) > 32 * 1024 * 1024 || size.0 == 0 || size.1 == 0 {
        return Err(invalid("image dimensions exceed 32 megapixels"));
    }
    let mut decoded = image::load_from_memory(&bytes).map_err(invalid)?;
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
    let scaled = if decoded.width() > dimension || decoded.height() > dimension {
        decoded.thumbnail(dimension, dimension)
    } else {
        decoded
    };
    let output_size = scaled.dimensions();
    let mut output = Cursor::new(Vec::new());
    scaled
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(invalid)?;
    Ok(PreparedImage {
        png: output.into_inner(),
        source_size: size,
        output_size,
    })
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
}
