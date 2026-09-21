use areal_runtime_protocol::{Error, ErrorCode, OutputChunk, OutputPage, OutputStream, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::VecDeque;

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
    retained: usize,
    capacity: usize,
    pub end: u64,
    pub closed: bool,
    pub truncated: bool,
}
impl Output {
    pub fn new(capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            retained: 0,
            capacity,
            end: 0,
            closed: false,
            truncated: false,
        }
    }
    pub fn append(&mut self, stream: OutputStream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
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
        let mut position = offset.max(begin);
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

#[cfg(test)]
mod tests {
    use super::*;
    use areal_runtime_protocol::{MAX_FRAME_BYTES, MAX_READ_BYTES};

    #[test]
    fn fragmented_output_pages_bound_metadata_without_losing_bytes() {
        let process = format!("{}:process:{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let mut output = Output::new(MAX_READ_BYTES);
        for i in 0..1024 {
            output.append(
                if i % 2 == 0 {
                    OutputStream::Stdout
                } else {
                    OutputStream::Stderr
                },
                b"x",
            );
        }
        output.closed = true;
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
    fn tiny_chunks_have_a_memory_bound_and_report_eviction() {
        let mut output = Output::new(MAX_READ_BYTES);
        for i in 0..10_000 {
            output.append(
                if i % 2 == 0 {
                    OutputStream::Stdout
                } else {
                    OutputStream::Stderr
                },
                b"x",
            );
        }
        assert_eq!(output.chunks.len(), MAX_RETAINED_CHUNKS);
        assert_eq!(output.retained, MAX_RETAINED_CHUNKS);
        assert!(output.page("process", None, 100).unwrap().gap);
        let mut output = Output::new(MAX_READ_BYTES);
        for _ in 0..10_000 {
            output.append(OutputStream::Stdout, b"x");
        }
        assert_eq!(output.chunks.len(), 3);
        assert!(!output.page("process", None, 100).unwrap().gap);
    }
}
