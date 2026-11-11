//! Streaming UTF-8 decoder that buffers incomplete trailing codepoints
//! between reads. SSH/PTY chunks can split a multi-byte UTF-8 character
//! across two reads — naive `from_utf8_lossy` per chunk turns each half
//! into U+FFFD, corrupting the glyph. This decoder buffers any incomplete
//! trailing codepoint and prepends it to the next chunk.

#[derive(Debug, Default)]
pub struct Utf8Decoder {
    remainder: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append `bytes` to the internal remainder, then return as `String`
    /// the longest prefix that ends on a complete UTF-8 codepoint
    /// boundary. Any trailing bytes that look like the start of an
    /// incomplete codepoint stay buffered for the next call.
    ///
    /// Invalid mid-stream byte sequences are passed through to
    /// `from_utf8_lossy`, which replaces them with U+FFFD — that's the
    /// correct behavior for genuinely malformed input.
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() && self.remainder.is_empty() {
            return String::new();
        }
        let mut combined = std::mem::take(&mut self.remainder);
        combined.extend_from_slice(bytes);

        let split = safe_split_point(&combined);
        let tail = combined.split_off(split);
        self.remainder = tail;
        String::from_utf8_lossy(&combined).into_owned()
    }
}

/// Return the byte offset such that `bytes[..offset]` contains no
/// incomplete trailing codepoint. Bytes from `offset` onward are the
/// start of a multi-byte codepoint that hasn't received all its
/// continuation bytes yet, and should be buffered.
fn safe_split_point(bytes: &[u8]) -> usize {
    let len = bytes.len();
    // A UTF-8 codepoint is at most 4 bytes (1 lead + 3 continuation).
    // So we only need to look back up to 3 bytes for an incomplete lead.
    let max_lookback = len.min(3);
    for i in 1..=max_lookback {
        let idx = len - i;
        let b = bytes[idx];
        if is_continuation(b) {
            continue;
        }
        if b & 0b1000_0000 == 0 {
            // ASCII byte — anything before it is fully formed.
            return len;
        }
        // Lead byte. How many continuation bytes does it expect?
        let expected = expected_continuations(b);
        let actual = i - 1;
        if expected.is_some() && actual < expected.unwrap() {
            return idx;
        }
        return len;
    }
    // All trailing bytes (up to 3) are continuation bytes with no lead
    // in sight — that's malformed input. Hand it to `from_utf8_lossy`
    // and let it emit U+FFFD; buffering won't help.
    len
}

fn is_continuation(b: u8) -> bool {
    b & 0b1100_0000 == 0b1000_0000
}

fn expected_continuations(lead: u8) -> Option<usize> {
    if lead & 0b1110_0000 == 0b1100_0000 {
        Some(1)
    } else if lead & 0b1111_0000 == 0b1110_0000 {
        Some(2)
    } else if lead & 0b1111_1000 == 0b1111_0000 {
        Some(3)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_ascii_passes_through() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b"https://claude.ai"), "https://claude.ai");
        assert!(d.remainder.is_empty());
    }

    #[test]
    fn empty_input_returns_empty() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b""), "");
    }

    #[test]
    fn complete_multibyte_passes_through() {
        // ─ (U+2500 box drawing) is 0xE2 0x94 0x80
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode("─".as_bytes()), "─");
        assert!(d.remainder.is_empty());
    }

    #[test]
    fn split_two_byte_codepoint_is_buffered_and_reassembled() {
        // © (U+00A9) is 0xC2 0xA9
        let bytes = "©".as_bytes();
        let mut d = Utf8Decoder::new();
        let first = d.decode(&bytes[..1]);
        assert_eq!(first, "");
        assert_eq!(d.remainder, bytes[..1]);
        let second = d.decode(&bytes[1..]);
        assert_eq!(second, "©");
        assert!(d.remainder.is_empty());
    }

    #[test]
    fn split_three_byte_codepoint_at_byte_one() {
        // ─ is 0xE2 0x94 0x80
        let bytes = "─".as_bytes();
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(&bytes[..1]), "");
        assert_eq!(d.decode(&bytes[1..]), "─");
    }

    #[test]
    fn split_three_byte_codepoint_at_byte_two() {
        let bytes = "─".as_bytes();
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(&bytes[..2]), "");
        assert_eq!(d.decode(&bytes[2..]), "─");
    }

    #[test]
    fn split_four_byte_codepoint() {
        // 🔒 (U+1F512) is 0xF0 0x9F 0x94 0x92
        let bytes = "🔒".as_bytes();
        for split_at in 1..bytes.len() {
            let mut d = Utf8Decoder::new();
            assert_eq!(d.decode(&bytes[..split_at]), "", "split_at={}", split_at);
            assert_eq!(d.decode(&bytes[split_at..]), "🔒", "split_at={}", split_at);
        }
    }

    #[test]
    fn url_with_trailing_partial_codepoint() {
        // The classic case: ASCII URL preceded by a multi-byte char,
        // chunk boundary lands inside the multi-byte char.
        let combined = "─https://claude.ai".as_bytes().to_vec();
        // Split mid-way through the leading box-char (after byte 1 of 3)
        let mut d = Utf8Decoder::new();
        let first = d.decode(&combined[..1]);
        assert_eq!(first, "");
        let second = d.decode(&combined[1..]);
        assert_eq!(second, "─https://claude.ai");
    }

    #[test]
    fn ascii_with_buffered_remainder_still_passes_full_url() {
        // Reverse case: chunk A ends with the start of a multi-byte char,
        // chunk B contains continuation bytes followed by the URL we care about.
        // Without the decoder, the URL would lose `ht` to U+FFFD replacement
        // of dangling continuation bytes? Actually lossy ADDS U+FFFD chars,
        // not removes — but the visible test is that the URL is intact and
        // no U+FFFD chars sneak into the URL itself.
        let prefix = "─".as_bytes();
        let url = b"https://claude.ai";

        let mut d = Utf8Decoder::new();
        // Chunk A: just the first byte of the box char
        assert_eq!(d.decode(&prefix[..1]), "");
        // Chunk B: rest of box char + URL
        let mut chunk_b = prefix[1..].to_vec();
        chunk_b.extend_from_slice(url);
        assert_eq!(d.decode(&chunk_b), "─https://claude.ai");
    }

    #[test]
    fn invalid_midstream_bytes_become_replacement_char() {
        // 0xFF is never valid in UTF-8. Surrounded by ASCII, it should
        // become U+FFFD without disturbing neighbors.
        let mut d = Utf8Decoder::new();
        let bytes = [b'a', 0xFF, b'b'];
        assert_eq!(d.decode(&bytes), "a\u{FFFD}b");
    }

    #[test]
    fn many_small_chunks_reassemble_full_message() {
        let msg = "Browser didn't open? Use the url below: https://claude.ai/oauth/authorize?code=true ─ box ✓";
        let bytes = msg.as_bytes();
        let mut d = Utf8Decoder::new();
        let mut out = String::new();
        for chunk in bytes.chunks(1) {
            out.push_str(&d.decode(chunk));
        }
        // Flush whatever is buffered (shouldn't be anything for valid input)
        out.push_str(&d.decode(&[]));
        assert_eq!(out, msg);
    }

    #[test]
    fn three_byte_codepoint_as_first_byte_only_buffers_correctly() {
        // ✓ (U+2713) is 0xE2 0x9C 0x93 — 3 bytes
        let bytes = "✓".as_bytes();
        let mut d = Utf8Decoder::new();
        // Just the lead byte
        assert_eq!(d.decode(&bytes[..1]), "");
        assert_eq!(d.remainder.len(), 1);
        // Add the second byte — still incomplete
        assert_eq!(d.decode(&bytes[1..2]), "");
        assert_eq!(d.remainder.len(), 2);
        // Add the final byte — complete
        assert_eq!(d.decode(&bytes[2..]), "✓");
        assert!(d.remainder.is_empty());
    }
}
