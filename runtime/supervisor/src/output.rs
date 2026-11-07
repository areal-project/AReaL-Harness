use areal_runtime_protocol::{Error, ErrorCode, OutputChunk, OutputPage, OutputStream, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{collections::VecDeque, fs::File, os::unix::fs::FileExt};

const MAX_PAGE_CHUNKS: usize = 128;
const MAX_RETAINED_CHUNKS: usize = 1024;

struct Chunk {
    start: u64,
    stream: OutputStream,
    bytes: Vec<u8>,
    consumed: usize,
}

pub(crate) struct Output {
    chunks: VecDeque<Chunk>,
    retained_file: Option<tempfile::TempPath>,
    retained_writer: Option<File>,
    retained: usize,
    capacity: usize,
    pub end: u64,
    pub closed: bool,
    pub truncated: bool,
}
impl Output {
    pub fn new(capacity: usize) -> Result<Self> {
        Ok(Self {
            retained_file: None,
            retained_writer: None,
            chunks: VecDeque::new(),
            retained: 0,
            capacity,
            end: 0,
            closed: false,
            truncated: false,
        })
    }
    pub fn append(&mut self, stream: OutputStream, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        // 仅在热窗口将被挤出时落盘；结束的进程不持有额外文件描述符。
        if self.retained_file.is_none()
            && (self.retained + bytes.len() > self.capacity
                || self.chunks.len() >= MAX_RETAINED_CHUNKS)
        {
            let retained = tempfile::NamedTempFile::new().map_err(retention_error)?;
            for chunk in &self.chunks {
                write_retained(
                    retained.as_file(),
                    chunk.start,
                    chunk.stream,
                    &chunk.bytes[chunk.consumed..],
                )?;
            }
            self.retained_writer = Some(retained.reopen().map_err(retention_error)?);
            self.retained_file = Some(retained.into_temp_path());
        }
        if let Some(file) = &self.retained_writer {
            write_retained(file, self.end, stream, bytes)?;
        }
        let start = self.end;
        self.end += bytes.len() as u64;
        let skip = bytes.len().saturating_sub(self.capacity);
        if let Some(last) = self.chunks.back_mut().filter(|last| {
            last.stream == stream
                && last.bytes.len() + bytes.len() - skip <= 4096
                && last.start + (last.bytes.len() - last.consumed) as u64 == start + skip as u64
        }) {
            last.bytes.extend_from_slice(&bytes[skip..]);
        } else {
            self.chunks.push_back(Chunk {
                start: start + skip as u64,
                stream,
                bytes: bytes[skip..].to_vec(),
                consumed: 0,
            });
        }
        self.retained += bytes.len() - skip;
        while self.chunks.len() > MAX_RETAINED_CHUNKS {
            let chunk = self.chunks.pop_front().unwrap();
            self.retained -= chunk.bytes.len() - chunk.consumed;
        }
        while self.retained > self.capacity {
            let first = self.chunks.front_mut().unwrap();
            let remove = (self.retained - self.capacity).min(first.bytes.len() - first.consumed);
            first.consumed += remove;
            first.start += remove as u64;
            self.retained -= remove;
            if first.consumed == first.bytes.len() {
                self.chunks.pop_front();
            }
        }
        Ok(())
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.retained_writer = None;
    }
    fn retained_page(&self, process_id: &str, offset: u64, max_bytes: usize) -> Result<OutputPage> {
        let count = max_bytes.min((self.end - offset) as usize);
        let mut encoded = vec![0u8; count * 2];
        let path = self
            .retained_file
            .as_ref()
            .ok_or_else(|| Error::new(ErrorCode::Unavailable, "retained output missing"))?;
        File::open(path)
            .and_then(|file| file.read_exact_at(&mut encoded, offset * 2))
            .map_err(retention_error)?;
        let mut chunks = Vec::new();
        let mut bytes = Vec::new();
        let mut tag = None;
        let mut position = offset;
        for pair in encoded.chunks_exact(2) {
            if tag.is_some_and(|old| old != pair[0]) {
                chunks.push(retained_chunk(process_id, position, tag.unwrap(), &bytes)?);
                bytes.clear();
                if chunks.len() == MAX_PAGE_CHUNKS {
                    break;
                }
            }
            tag = Some(pair[0]);
            bytes.push(pair[1]);
            position += 1;
        }
        if !bytes.is_empty() {
            chunks.push(retained_chunk(process_id, position, tag.unwrap(), &bytes)?);
        }
        Ok(OutputPage {
            chunks,
            next_cursor: format!("{process_id}/{position}"),
            gap: false,
            truncated: self.truncated,
            closed: self.closed && position == self.end,
        })
    }
    pub fn page(
        &self,
        process_id: &str,
        after: Option<&str>,
        max_bytes: usize,
    ) -> Result<OutputPage> {
        let prefix = format!("{process_id}/");
        let offset = match after {
            None => 0,
            Some(cursor) => cursor
                .strip_prefix(&prefix)
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::StaleHandle,
                        "cursor belongs to another process or epoch",
                    )
                })?,
        };
        if offset > self.end {
            return Err(Error::new(
                ErrorCode::InvalidArgument,
                "cursor exceeds produced output",
            ));
        }
        let begin = self.chunks.front().map_or(self.end, |c| c.start);
        if offset < begin {
            return self.retained_page(process_id, offset, max_bytes);
        }
        let mut position = offset;
        let mut remaining = max_bytes;
        let mut chunks = Vec::new();
        for chunk in &self.chunks {
            let skip = position.saturating_sub(chunk.start) as usize;
            let retained = &chunk.bytes[chunk.consumed..];
            if skip >= retained.len() {
                continue;
            }
            let bytes = &retained[skip..][..remaining.min(retained.len() - skip)];
            position += bytes.len() as u64;
            remaining -= bytes.len();
            chunks.push(OutputChunk {
                cursor: format!("{prefix}{position}"),
                stream: chunk.stream,
                data_base64: STANDARD.encode(bytes),
            });
            // maxBytes 只限制原始字节；碎片的游标和 JSON 字段也必须有界。
            if remaining == 0 || chunks.len() == MAX_PAGE_CHUNKS {
                break;
            }
        }
        Ok(OutputPage {
            chunks,
            next_cursor: format!("{prefix}{position}"),
            gap: offset < begin,
            truncated: self.truncated,
            closed: self.closed && position == self.end,
        })
    }
}

fn write_retained(file: &File, mut offset: u64, stream: OutputStream, bytes: &[u8]) -> Result<()> {
    // 每字节带流标记，游标可直接定位；无需随碎片数增长的内存索引。
    let tag = match stream {
        OutputStream::Stdout => 0,
        OutputStream::Stderr => 1,
        OutputStream::Pty => 2,
    };
    for block in bytes.chunks(64 * 1024) {
        let encoded: Vec<u8> = block.iter().flat_map(|byte| [tag, *byte]).collect();
        file.write_all_at(&encoded, offset * 2)
            .map_err(retention_error)?;
        offset += block.len() as u64;
    }
    Ok(())
}
fn retention_error(error: std::io::Error) -> Error {
    Error::new(
        ErrorCode::Unavailable,
        format!("process output retention failed: {error}"),
    )
}
fn retained_chunk(process: &str, end: u64, tag: u8, bytes: &[u8]) -> Result<OutputChunk> {
    let stream = match tag {
        0 => OutputStream::Stdout,
        1 => OutputStream::Stderr,
        2 => OutputStream::Pty,
        _ => {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "invalid retained stream tag",
            ));
        }
    };
    Ok(OutputChunk {
        cursor: format!("{process}/{end}"),
        stream,
        data_base64: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use areal_runtime_protocol::{MAX_FRAME_BYTES, MAX_READ_BYTES};

    #[test]
    fn fragmented_output_pages_bound_metadata_without_losing_bytes() {
        let process = format!("{}:process:{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let mut output = Output::new(MAX_READ_BYTES).unwrap();
        for i in 0..1024 {
            output
                .append(
                    if i % 2 == 0 {
                        OutputStream::Stdout
                    } else {
                        OutputStream::Stderr
                    },
                    b"x",
                )
                .unwrap();
        }
        output.close();
        let mut cursor = None;
        let mut received = 0;
        loop {
            let page = output
                .page(&process, cursor.as_deref(), MAX_READ_BYTES)
                .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() < MAX_FRAME_BYTES);
            for chunk in &page.chunks {
                let expected = if received % 2 == 0 {
                    OutputStream::Stdout
                } else {
                    OutputStream::Stderr
                };
                assert_eq!(chunk.stream, expected);
                received += STANDARD.decode(&chunk.data_base64).unwrap().len();
            }
            assert!(!page.gap && !page.truncated);
            if page.closed {
                break;
            }
            assert_ne!(cursor.as_ref(), Some(&page.next_cursor));
            cursor = Some(page.next_cursor);
        }
        assert_eq!(received, 1024);
    }

    #[test]
    fn tiny_chunks_have_a_memory_bound_and_retained_readback() {
        let mut output = Output::new(MAX_READ_BYTES).unwrap();
        for i in 0..10_000 {
            output
                .append(
                    if i % 2 == 0 {
                        OutputStream::Stdout
                    } else {
                        OutputStream::Stderr
                    },
                    b"x",
                )
                .unwrap();
        }
        assert_eq!(output.chunks.len(), MAX_RETAINED_CHUNKS);
        assert_eq!(output.retained, MAX_RETAINED_CHUNKS);
        assert!(!output.page("process", None, 100).unwrap().gap);
        let mut output = Output::new(MAX_READ_BYTES).unwrap();
        for _ in 0..10_000 {
            output.append(OutputStream::Stdout, b"x").unwrap();
        }
        assert_eq!(output.chunks.len(), 3);
        assert!(!output.page("process", None, 100).unwrap().gap);
    }
    #[test]
    fn retained_bytes_streams_and_file_permissions_survive_cache_eviction() {
        use std::os::unix::fs::PermissionsExt;
        let mut output = Output::new(4).unwrap();
        assert!(output.retained_file.is_none());
        output.append(OutputStream::Stdout, b"old error\n").unwrap();
        output.append(OutputStream::Stderr, &[0, 255, 2]).unwrap();
        output.append(OutputStream::Pty, b"done").unwrap();
        output.close();
        let page = output.page("p", None, 64).unwrap();
        assert!(page.closed && !page.gap && !page.truncated);
        assert_eq!(page.chunks.len(), 3);
        assert_eq!(
            STANDARD.decode(&page.chunks[0].data_base64).unwrap(),
            b"old error\n"
        );
        assert_eq!(page.chunks[1].stream, OutputStream::Stderr);
        assert_eq!(
            STANDARD.decode(&page.chunks[1].data_base64).unwrap(),
            [0, 255, 2]
        );
        // 损坏保留文件不能返回一个看似完整的成功页。
        let retained_path = output.retained_file.as_ref().unwrap().to_path_buf();
        assert_eq!(
            std::fs::metadata(&retained_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::OpenOptions::new()
            .write(true)
            .open(&retained_path)
            .unwrap()
            .set_len(0)
            .unwrap();
        assert_eq!(
            output.page("p", None, 64).unwrap_err().code,
            ErrorCode::Unavailable
        );
        drop(output);
        assert!(!retained_path.exists());
    }
}
