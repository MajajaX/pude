pub const MAX_FILE_READ_BYTES: u64 = 20 * 1024 * 1024;

pub const UNSUPPORTED_TEXT_ERROR: &str =
    "Unable to read file. Only UTF-8 and UTF-8 with BOM text files are supported.";
pub const UNSUPPORTED_LINE_ENDING_ERROR: &str =
    "Unable to read file. Only LF and CRLF line endings are supported.";

pub fn decode_text_bytes(bytes: &[u8]) -> Result<(String, String, bool), String> {
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let payload = if bom { &bytes[3..] } else { bytes };
    // Validate UTF-8 before looking at line endings so an invalid encoding
    // keeps reporting the encoding error even when a bare CR is present.
    let text = std::str::from_utf8(payload).map_err(|_| UNSUPPORTED_TEXT_ERROR)?;
    if memchr::memchr(b'\r', text.as_bytes()).is_none() {
        // LF-only fast path: one bulk copy (no per-char pushes), and the line
        // ending markers come straight from a memchr scan.
        let line_endings: String = memchr::memchr_iter(b'\n', text.as_bytes())
            .map(|_| 'l')
            .collect();
        return Ok((text.to_string(), line_endings, bom));
    }

    // CRLF path: copy the segment before each CR, count the LF markers inside
    // that segment, then handle the CRLF itself. Segments are split at ASCII
    // bytes, so they stay valid UTF-8 boundaries of the validated text.
    let mut normalized = String::with_capacity(text.len());
    let mut line_endings = String::new();
    let mut rest = text.as_bytes();
    while let Some(cr_index) = memchr::memchr(b'\r', rest) {
        let segment = &rest[..cr_index];
        let segment = std::str::from_utf8(segment).expect("split at ASCII keeps UTF-8");
        normalized.push_str(segment);
        line_endings.extend(memchr::memchr_iter(b'\n', segment.as_bytes()).map(|_| 'l'));
        match rest.get(cr_index + 1) {
            Some(b'\n') => {
                normalized.push('\n');
                line_endings.push('c');
                rest = &rest[cr_index + 2..];
            }
            _ => return Err(UNSUPPORTED_LINE_ENDING_ERROR.to_string()),
        }
    }
    normalized.push_str(std::str::from_utf8(rest).expect("split at ASCII keeps UTF-8"));
    line_endings.extend(memchr::memchr_iter(b'\n', rest).map(|_| 'l'));
    Ok((normalized, line_endings, bom))
}

pub fn preferred_line_ending(line_endings: &str) -> &str {
    let crlf = line_endings.chars().filter(|marker| *marker == 'c').count();
    let lf = line_endings.chars().filter(|marker| *marker == 'l').count();
    if crlf > lf {
        "crlf"
    } else {
        "lf"
    }
}

pub fn serialize_save_content(
    content: &str,
    line_endings: Option<&str>,
    preferred: &str,
    bom: bool,
) -> Result<Vec<u8>, String> {
    let input = content.as_bytes();
    let fallback = if preferred == "crlf" { 'c' } else { 'l' };
    let source = line_endings.unwrap_or_default();
    let mut input_crlf = 0_usize;
    let mut input_breaks = 0_usize;
    let has_cr = memchr::memchr(b'\r', input).is_some();
    if has_cr {
        for index in memchr::memchr2_iter(b'\r', b'\n', input) {
            if input[index] == b'\n' && index > 0 && input[index - 1] == b'\r' {
                continue;
            }
            if input[index] == b'\r' {
                input_crlf += usize::from(input.get(index + 1) == Some(&b'\n'));
            }
            input_breaks += 1;
        }
    } else {
        input_breaks = memchr::memchr_iter(b'\n', input).count();
    }
    let output_crlf = count_output_crlf_markers(source, input_breaks, fallback);
    let output_size = input
        .len()
        .checked_sub(input_crlf)
        .and_then(|size| size.checked_add(output_crlf))
        .and_then(|size| size.checked_add(if bom { 3 } else { 0 }));
    let Some(output_size) = output_size.filter(|size| (*size as u64) <= MAX_FILE_READ_BYTES) else {
        return Err(format!(
            "Unable to save file. The file is too large to save (maximum {} MiB).",
            MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    };
    let mut output = Vec::with_capacity(output_size);
    if bom {
        output.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    if !has_cr && output_crlf == 0 {
        output.extend_from_slice(input);
        return Ok(output);
    }
    if source.is_ascii() {
        if has_cr {
            append_mapped_ascii(input, source.as_bytes(), fallback, &mut output);
        } else {
            append_mapped_lf_ascii(input, source.as_bytes(), fallback, &mut output);
        }
    } else {
        append_mapped_unicode(input, source, fallback, &mut output);
    }
    Ok(output)
}

fn count_output_crlf_markers(source: &str, input_breaks: usize, fallback: char) -> usize {
    if source.is_ascii() {
        let markers = &source.as_bytes()[..source.len().min(input_breaks)];
        let mapped_crlf = if fallback == 'c' {
            markers.len() - memchr::memchr_iter(b'l', markers).count()
        } else {
            memchr::memchr_iter(b'c', markers).count()
        };
        return mapped_crlf + usize::from(fallback == 'c') * (input_breaks - markers.len());
    }

    let mut mapped_breaks = 0;
    let mut output_crlf = 0;
    for marker in source.chars().take(input_breaks) {
        mapped_breaks += 1;
        output_crlf += usize::from(match marker {
            'c' => true,
            'l' => false,
            _ => fallback == 'c',
        });
    }
    if fallback == 'c' {
        output_crlf += input_breaks - mapped_breaks;
    }
    output_crlf
}

fn append_mapped_lf_ascii(input: &[u8], markers: &[u8], fallback: char, output: &mut Vec<u8>) {
    let mut marker_index = 0;
    let mut cursor = 0;
    for boundary in memchr::memchr_iter(b'\n', input) {
        let marker = markers.get(marker_index).copied().unwrap_or(fallback as u8);
        marker_index += 1;
        if marker == b'c' || (marker != b'l' && fallback == 'c') {
            // Keep ordinary LF boundaries inside the copied span. Dense maps
            // often have few CRLF markers, so emitting only at those markers
            // avoids one Vec operation per unchanged line.
            output.extend_from_slice(&input[cursor..boundary]);
            output.extend_from_slice(b"\r\n");
            cursor = boundary + 1;
        }
    }
    output.extend_from_slice(&input[cursor..]);
}

fn append_mapped_ascii(input: &[u8], markers: &[u8], fallback: char, output: &mut Vec<u8>) {
    let mut marker_index = 0;
    let mut cursor = 0;
    for boundary in memchr::memchr2_iter(b'\r', b'\n', input) {
        // The LF half of a CRLF pair is part of the preceding boundary.
        // `cursor` already advances past it when the CR is emitted.
        if input[boundary] == b'\n' && boundary > 0 && input[boundary - 1] == b'\r' {
            continue;
        }
        output.extend_from_slice(&input[cursor..boundary]);
        let marker = markers.get(marker_index).copied().unwrap_or(fallback as u8);
        marker_index += 1;
        let is_input_crlf = input[boundary] == b'\r' && input.get(boundary + 1) == Some(&b'\n');
        if marker == b'c' || (marker != b'l' && fallback == 'c') {
            output.extend_from_slice(b"\r\n");
        } else {
            output.push(b'\n');
        }
        cursor = boundary + 1 + usize::from(is_input_crlf);
    }
    output.extend_from_slice(&input[cursor..]);
}

fn append_mapped_unicode(input: &[u8], source: &str, fallback: char, output: &mut Vec<u8>) {
    let mut markers = source.chars();
    let mut cursor = 0;
    for boundary in memchr::memchr2_iter(b'\r', b'\n', input) {
        if input[boundary] == b'\n' && boundary > 0 && input[boundary - 1] == b'\r' {
            continue;
        }
        output.extend_from_slice(&input[cursor..boundary]);
        let marker = markers.next().unwrap_or(fallback);
        let is_input_crlf = input[boundary] == b'\r' && input.get(boundary + 1) == Some(&b'\n');
        if marker == 'c' || (!matches!(marker, 'l') && fallback == 'c') {
            output.extend_from_slice(b"\r\n");
        } else {
            output.push(b'\n');
        }
        cursor = boundary + 1 + usize::from(is_input_crlf);
    }
    output.extend_from_slice(&input[cursor..]);
}

// Byte-for-byte regression tests. The reference functions
// below are exact copies of the original, unoptimized implementations; the optimized
// versions must agree with them on every case, including error values.
#[cfg(test)]
mod text_codec_round_trip_tests {
    use super::{
        decode_text_bytes, serialize_save_content, UNSUPPORTED_LINE_ENDING_ERROR,
        UNSUPPORTED_TEXT_ERROR,
    };

    fn reference_decode_text_bytes(bytes: &[u8]) -> Result<(String, String, bool), String> {
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let payload = if bom { &bytes[3..] } else { bytes };
        let text = std::str::from_utf8(payload).map_err(|_| UNSUPPORTED_TEXT_ERROR)?;
        let mut normalized = String::with_capacity(text.len());
        let mut line_endings = String::new();
        let mut chars = text.chars().peekable();
        while let Some(character) = chars.next() {
            match character {
                '\r' if chars.peek() == Some(&'\n') => {
                    chars.next();
                    normalized.push('\n');
                    line_endings.push('c');
                }
                '\r' => return Err(UNSUPPORTED_LINE_ENDING_ERROR.to_string()),
                '\n' => {
                    normalized.push('\n');
                    line_endings.push('l');
                }
                other => normalized.push(other),
            }
        }
        Ok((normalized, line_endings, bom))
    }

    fn reference_serialize_save_content(
        content: &str,
        line_endings: Option<&str>,
        preferred: &str,
        bom: bool,
    ) -> Result<Vec<u8>, String> {
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let fallback = if preferred == "crlf" { "c" } else { "l" };
        let source = line_endings.unwrap_or_default();
        let mut source_markers = source.chars();
        let mut bytes = if bom {
            vec![0xef, 0xbb, 0xbf]
        } else {
            Vec::new()
        };
        let lines: Vec<&str> = normalized.split('\n').collect();
        for (index, line) in lines.iter().enumerate() {
            bytes.extend_from_slice(line.as_bytes());
            if index + 1 >= lines.len() {
                continue;
            }
            let marker = source_markers
                .next()
                .filter(|marker| *marker == 'c' || *marker == 'l')
                .unwrap_or_else(|| {
                    fallback
                        .chars()
                        .next()
                        .expect("fallback marker is non-empty")
                });
            if marker == 'c' {
                bytes.extend_from_slice(b"\r\n");
            } else {
                bytes.push(b'\n');
            }
        }
        if bytes.len() as u64 > super::MAX_FILE_READ_BYTES {
            return Err(format!(
                "Unable to save file. The file is too large to save (maximum {} MiB).",
                super::MAX_FILE_READ_BYTES / (1024 * 1024)
            ));
        }
        Ok(bytes)
    }

    fn structured_decode_cases() -> Vec<Vec<u8>> {
        // Rust literals reject \x escapes above 0x7f, so non-ASCII bytes are
        // spelled as integer slices.
        let bom: &[u8] = &[0xef, 0xbb, 0xbf];
        vec![
            Vec::new(),
            bom.to_vec(),
            b"hello".to_vec(),
            b"hello\n".to_vec(),
            b"\n".to_vec(),
            b"\r\n".to_vec(),
            b"\r\n\r\n".to_vec(),
            b"a\r\nb".to_vec(),
            b"a\r\nb\n".to_vec(),
            b"\n\r\n\r\na\nb\r\nc".to_vec(),
            "multi 中文 😀 utf8\r\nsecond 第二 line".as_bytes().to_vec(),
            [bom, b"bom\r\nlf\nplain".as_slice()].concat(),
            // Bare CR and CR-CR must keep reporting the line-ending error.
            b"\r".to_vec(),
            b"\ra".to_vec(),
            b"a\rb".to_vec(),
            b"a\r\rb".to_vec(),
            b"a\nb\r".to_vec(),
            b"\r\n\r".to_vec(),
            // Invalid UTF-8 must keep reporting the encoding error, with and
            // without a BOM, even when a bare CR is also present.
            [b"bad ".as_slice(), &[0xff, 0xfe], b" utf8".as_slice()].concat(),
            [bom, b"bad ".as_slice(), &[0xff], b" utf8".as_slice()].concat(),
            [&[0xff], b"\r".as_slice()].concat(),
        ]
    }

    #[test]
    fn decode_text_bytes_matches_reference_on_crlf_lf_mixed_bom_and_multibyte() {
        for case in structured_decode_cases() {
            assert_eq!(
                decode_text_bytes(&case),
                reference_decode_text_bytes(&case),
                "decode mismatch for case: {case:?}"
            );
        }
    }

    #[test]
    fn decode_text_bytes_matches_reference_on_large_mixed_input() {
        // Several MiB of deterministic mixed line endings and multibyte UTF-8.
        let units = [
            "a line without a trailing newline",
            "crlf terminated\r\n",
            "lf terminated\n",
            "multibyte 中文\r\n",
            "😀 emoji\n",
            "\r\n",
        ];
        let mut bytes = Vec::new();
        for index in 0..400_000_usize {
            bytes.extend_from_slice(units[index % units.len()].as_bytes());
        }
        assert!(bytes.len() > 5 * 1024 * 1024, "fixture should exceed 5 MiB");
        assert_eq!(
            decode_text_bytes(&bytes),
            reference_decode_text_bytes(&bytes),
            "large mixed decode mismatch"
        );
    }

    fn structured_serialize_cases() -> Vec<(String, Option<&'static str>, &'static str, bool)> {
        vec![
            (String::new(), Some(""), "lf", false),
            (String::new(), None, "crlf", true),
            ("no newline".to_string(), None, "lf", false),
            ("one\n".to_string(), Some("c"), "lf", false),
            ("a\nb\nc".to_string(), Some("ccc"), "lf", false),
            ("a\nb\nc".to_string(), Some("cl"), "crlf", false),
            ("a\nb\nc".to_string(), Some("lcl"), "crlf", false),
            ("a\nb\nc".to_string(), None, "crlf", false),
            ("a\nb\nc".to_string(), None, "lf", false),
            // Content still containing CR characters is normalized first.
            ("a\r\nb".to_string(), Some("cc"), "lf", false),
            ("a\rb".to_string(), Some("l"), "crlf", false),
            ("a\r\r\nb".to_string(), Some("cc"), "lf", false),
            // Invalid source markers occupy their boundary's slot.
            ("a\nb\nc".to_string(), Some("xcl"), "lf", false),
            ("a\nb\nc".to_string(), Some("cxl"), "crlf", false),
            ("a\nb\nc".to_string(), Some("😀c"), "lf", false),
            // Running out of markers falls back per line.
            ("a\nb\nc".to_string(), Some("c"), "lf", false),
            ("a\nb\nc".to_string(), Some(""), "crlf", true),
            ("trailing\n".to_string(), Some(""), "lf", false),
            ("\n\n\n".to_string(), Some("clc"), "crlf", false),
            ("ends with cr\r".to_string(), Some("c"), "lf", false),
            ("ends with crlf\r\n".to_string(), Some("cc"), "lf", false),
            (
                "multibyte 中文\r\n😀\n".to_string(),
                Some("cl"),
                "crlf",
                true,
            ),
        ]
    }

    #[test]
    fn serialize_save_content_matches_reference_on_line_endings_bom_and_markers() {
        for (content, line_endings, preferred, bom) in structured_serialize_cases() {
            assert_eq!(
                serialize_save_content(&content, line_endings, preferred, bom),
                reference_serialize_save_content(&content, line_endings, preferred, bom),
                "serialize mismatch for content: {content:?}, line_endings: {line_endings:?}, preferred: {preferred}, bom: {bom}"
            );
            let output = serialize_save_content(&content, line_endings, preferred, bom).unwrap();
            assert_eq!(
                output.capacity(),
                output.len(),
                "output capacity must include all CRLF and BOM bytes"
            );
        }
    }

    #[test]
    fn serialize_save_content_matches_reference_at_the_20_mib_output_limit() {
        let limit = super::MAX_FILE_READ_BYTES as usize;

        let exact_plain = "x".repeat(limit);
        assert_eq!(
            serialize_save_content(&exact_plain, None, "lf", false),
            reference_serialize_save_content(&exact_plain, None, "lf", false)
        );

        let exact_bom = "x".repeat(limit - 3);
        let bom_output = serialize_save_content(&exact_bom, None, "lf", true).unwrap();
        assert_eq!(bom_output.len(), limit);
        assert_eq!(&bom_output[..3], &[0xef, 0xbb, 0xbf]);
        assert_eq!(
            bom_output,
            reference_serialize_save_content(&exact_bom, None, "lf", true).unwrap()
        );

        let exact_crlf = format!("{}\n", "x".repeat(limit - 2));
        let crlf_output = serialize_save_content(&exact_crlf, Some("c"), "lf", false).unwrap();
        assert_eq!(crlf_output.len(), limit);
        assert!(crlf_output.ends_with(b"\r\n"));
        assert_eq!(
            crlf_output,
            reference_serialize_save_content(&exact_crlf, Some("c"), "lf", false).unwrap()
        );

        let too_large = format!("{}\n", "x".repeat(limit - 1));
        let expected_error = reference_serialize_save_content(&too_large, Some("c"), "lf", false)
            .expect_err("CRLF expansion should cross the 20 MiB output limit");
        assert_eq!(
            serialize_save_content(&too_large, Some("c"), "lf", false),
            Err(expected_error)
        );
    }

    #[test]
    fn serialize_save_content_matches_reference_on_large_input() {
        // ~10 MiB of lines with markers around the boundary-count edge cases.
        let line = "a reasonably long line of text with several characters in it";
        let line_count = 170_000_usize;
        let mut content = String::with_capacity(line.len() * line_count);
        for _ in 0..line_count {
            content.push_str(line);
            content.push('\n');
        }
        let full_markers: String = (0..line_count - 1)
            .map(|index| if index % 3 == 0 { 'c' } else { 'l' })
            .collect();
        let short_markers: String = full_markers.chars().take(10).collect();
        let invalid_markers: String = full_markers
            .chars()
            .take(100)
            .enumerate()
            .map(|(index, marker)| if index == 7 { 'x' } else { marker })
            .collect();
        for (line_endings, preferred, bom) in [
            (None, "lf", false),
            (Some(full_markers.as_str()), "crlf", false),
            (Some(short_markers.as_str()), "crlf", false),
            (Some(invalid_markers.as_str()), "lf", false),
            (Some(""), "crlf", true),
        ] {
            assert_eq!(
                serialize_save_content(&content, line_endings, preferred, bom),
                reference_serialize_save_content(&content, line_endings, preferred, bom),
                "large serialize mismatch for line_endings length {:?}",
                line_endings.map(str::len)
            );
        }
    }
}
