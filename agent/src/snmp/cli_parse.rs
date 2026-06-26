//! Parser for net-snmp CLI tool output (`snmpget`/`snmpwalk`/`snmpbulkwalk`
//! invoked with `-On` for numeric OIDs).
//!
//! Used by the SNMP-via-jump path: we exec the CLI tool on a jump host that
//! has L3 reach to the device, capture stdout, and convert it back to the
//! same `SnmpValueEntry` shape the in-process UDP SNMP client produces.
//! That keeps every downstream consumer (interface stats, neighbor
//! discovery, frontend rendering) source-agnostic.
//!
//! Net-snmp's `-On` output is line-oriented:
//!
//! ```text
//! .1.3.6.1.2.1.1.5.0 = STRING: "router1"
//! .1.3.6.1.2.1.2.2.1.10.1 = Counter32: 12345
//! .1.3.6.1.2.1.2.2.1.6.1 = Hex-STRING: 00 11 22 AA BB CC
//! .1.3.6.1.2.1.4.20.1.1.10.0.0.1 = IpAddress: 10.0.0.1
//! .1.3.6.1.2.1.1.3.0 = Timeticks: (12345) 0:02:03.45
//! .1.3.6.1.2.1.1.5.0 = No Such Object available on this OID
//! ```
//!
//! Multi-line values (OctetString containing newlines, long Hex-STRING) are
//! handled by treating any line that doesn't begin with `.<digit>` as a
//! continuation of the previous entry.

use super::{SnmpValue, SnmpValueEntry};

/// Parse net-snmp `-On` output (works for snmpget, snmpwalk, snmpbulkwalk).
///
/// Returns one `SnmpValueEntry` per response varbind. Lines that can't be
/// parsed (banners, blank lines) are skipped silently — net-snmp's tools
/// occasionally emit warnings to stdout that aren't varbinds.
pub fn parse_snmp_output(s: &str) -> Vec<SnmpValueEntry> {
    let mut entries: Vec<SnmpValueEntry> = Vec::new();
    let mut current: Option<(String, String, String)> = None; // (oid, type_token, value_buf)

    for raw_line in s.lines() {
        if looks_like_new_entry(raw_line) {
            // Flush the previous entry before starting a new one.
            if let Some((oid, ty, value)) = current.take() {
                entries.push(build_entry(oid, ty, value));
            }
            if let Some(parsed) = parse_first_line(raw_line) {
                current = Some(parsed);
            }
        } else if let Some(cur) = current.as_mut() {
            // Continuation of the previous entry's value (multi-line string).
            cur.2.push('\n');
            cur.2.push_str(raw_line);
        }
        // Else: lines before the first varbind (banners, etc.) — drop.
    }

    if let Some((oid, ty, value)) = current.take() {
        entries.push(build_entry(oid, ty, value));
    }

    entries
}

/// A line begins a new entry iff it starts with the OID marker.
fn looks_like_new_entry(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed
        .strip_prefix('.')
        .map(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

/// Parse the leading line of an entry: `<oid> = <type-or-error>`.
/// Returns (oid, type_token, value_text). For error markers (No Such Object
/// etc.), `type_token` is the marker text and `value_text` is empty.
fn parse_first_line(line: &str) -> Option<(String, String, String)> {
    let line = line.trim();
    let eq_idx = line.find(" = ")?;
    let oid = strip_leading_dot(&line[..eq_idx]).to_string();
    let rhs = &line[eq_idx + 3..];

    // Special error markers carry no `:` — match them first.
    for marker in ["No Such Object", "No Such Instance", "No more variables"] {
        if rhs.starts_with(marker) {
            return Some((oid, marker.to_string(), String::new()));
        }
    }

    // Standard `<TypeName>: <value>` form.
    if let Some(colon_idx) = rhs.find(':') {
        let ty = rhs[..colon_idx].trim().to_string();
        let value = rhs[colon_idx + 1..].trim_start().to_string();
        return Some((oid, ty, value));
    }

    // Last resort: an unrecognized RHS — store it as Unknown.
    Some((oid, "Unknown".to_string(), rhs.to_string()))
}

fn strip_leading_dot(s: &str) -> &str {
    s.strip_prefix('.').unwrap_or(s)
}

fn build_entry(oid: String, ty: String, value_text: String) -> SnmpValueEntry {
    let (value, value_type) = parse_typed_value(&ty, &value_text);
    SnmpValueEntry { oid, value, value_type }
}

fn parse_typed_value(ty: &str, raw: &str) -> (SnmpValue, String) {
    // Special markers first.
    match ty {
        "No Such Object" => return (SnmpValue::NoSuchObject, "NoSuchObject".to_string()),
        "No Such Instance" => return (SnmpValue::NoSuchInstance, "NoSuchInstance".to_string()),
        "No more variables" => return (SnmpValue::EndOfMibView, "EndOfMibView".to_string()),
        _ => {}
    }

    match ty {
        "INTEGER" => {
            // INTEGER values can be `42` or `up(1)` (named enums). Strip the
            // parenthetical to get the underlying integer.
            let n = raw
                .split_whitespace()
                .next()
                .and_then(|tok| {
                    tok.split('(')
                        .nth(1)
                        .and_then(|inner| inner.trim_end_matches(')').parse::<i64>().ok())
                        .or_else(|| tok.parse::<i64>().ok())
                });
            match n {
                Some(v) => (SnmpValue::Integer(v), "Integer".into()),
                None => (SnmpValue::Unknown(raw.to_string()), "Unknown".into()),
            }
        }
        "Counter32" => parse_unsigned32(raw)
            .map(|n| (SnmpValue::Counter32(n), "Counter32".into()))
            .unwrap_or_else(|| (SnmpValue::Unknown(raw.to_string()), "Unknown".into())),
        "Counter64" => parse_unsigned64(raw)
            .map(|n| (SnmpValue::Counter64(n), "Counter64".into()))
            .unwrap_or_else(|| (SnmpValue::Unknown(raw.to_string()), "Unknown".into())),
        "Gauge32" => parse_unsigned32(raw)
            .map(|n| (SnmpValue::Gauge32(n), "Gauge32".into()))
            .unwrap_or_else(|| (SnmpValue::Unknown(raw.to_string()), "Unknown".into())),
        "Timeticks" => {
            // Format: `(12345) 0:02:03.45` — the parenthetical is the raw u32.
            let raw_ticks = raw
                .strip_prefix('(')
                .and_then(|s| s.split(')').next())
                .and_then(|s| s.parse::<u32>().ok());
            match raw_ticks {
                Some(n) => (SnmpValue::TimeTicks(n), "TimeTicks".into()),
                None => (SnmpValue::Unknown(raw.to_string()), "Unknown".into()),
            }
        }
        "IpAddress" | "Network Address" => (SnmpValue::IpAddress(raw.to_string()), "IpAddress".into()),
        "OID" | "Object ID" | "OBJECT IDENTIFIER" => {
            (SnmpValue::ObjectId(strip_leading_dot(raw).to_string()), "ObjectIdentifier".into())
        }
        "STRING" => {
            // Strip surrounding double quotes if present.
            let unquoted = raw
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(raw);
            (SnmpValue::String(unquoted.to_string()), "OctetString".into())
        }
        "Hex-STRING" => {
            // `00 11 22 AA BB CC` — hex pairs separated by spaces.
            let bytes: Result<Vec<u8>, _> = raw
                .split_whitespace()
                .map(|pair| u8::from_str_radix(pair, 16))
                .collect();
            match bytes {
                Ok(b) => (SnmpValue::OctetString(b), "OctetString".into()),
                Err(_) => (SnmpValue::Unknown(raw.to_string()), "Unknown".into()),
            }
        }
        "BITS" => (SnmpValue::OctetString(raw.as_bytes().to_vec()), "OctetString".into()),
        "" => (SnmpValue::Null, "Null".into()),
        _ => (SnmpValue::Unknown(format!("{}: {}", ty, raw)), "Unknown".into()),
    }
}

fn parse_unsigned32(raw: &str) -> Option<u32> {
    raw.split_whitespace().next().and_then(|tok| tok.parse().ok())
}

fn parse_unsigned64(raw: &str) -> Option<u64> {
    raw.split_whitespace().next().and_then(|tok| tok.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(s: &str) -> SnmpValueEntry {
        let v = parse_snmp_output(s);
        assert_eq!(v.len(), 1, "expected exactly one entry, got: {v:?}");
        v.into_iter().next().unwrap()
    }

    #[test]
    fn parses_string_with_quotes() {
        let e = first(r#".1.3.6.1.2.1.1.5.0 = STRING: "router1.example.com""#);
        assert_eq!(e.oid, "1.3.6.1.2.1.1.5.0");
        assert!(matches!(e.value, SnmpValue::String(ref s) if s == "router1.example.com"));
        assert_eq!(e.value_type, "OctetString");
    }

    #[test]
    fn parses_string_without_quotes() {
        let e = first(".1.3.6.1.2.1.1.5.0 = STRING: bare-name");
        assert!(matches!(e.value, SnmpValue::String(ref s) if s == "bare-name"));
    }

    #[test]
    fn parses_counter32() {
        let e = first(".1.3.6.1.2.1.2.2.1.10.1 = Counter32: 12345");
        assert!(matches!(e.value, SnmpValue::Counter32(12345)));
    }

    #[test]
    fn parses_counter64() {
        let e = first(".1.3.6.1.2.1.31.1.1.1.6.1 = Counter64: 9876543210");
        assert!(matches!(e.value, SnmpValue::Counter64(9876543210)));
    }

    #[test]
    fn parses_gauge32() {
        let e = first(".1.3.6.1.2.1.2.2.1.5.1 = Gauge32: 1000000000");
        assert!(matches!(e.value, SnmpValue::Gauge32(1_000_000_000)));
    }

    #[test]
    fn parses_integer_plain() {
        let e = first(".1.3.6.1.2.1.2.2.1.7.1 = INTEGER: 1");
        assert!(matches!(e.value, SnmpValue::Integer(1)));
    }

    #[test]
    fn parses_integer_with_named_enum() {
        // ifAdminStatus = up(1) — net-snmp emits the enum name with the number.
        let e = first(".1.3.6.1.2.1.2.2.1.7.1 = INTEGER: up(1)");
        assert!(matches!(e.value, SnmpValue::Integer(1)));
    }

    #[test]
    fn parses_timeticks_extracts_raw_value() {
        let e = first(".1.3.6.1.2.1.1.3.0 = Timeticks: (12345) 0:02:03.45");
        assert!(matches!(e.value, SnmpValue::TimeTicks(12345)));
    }

    #[test]
    fn parses_ip_address() {
        let e = first(".1.3.6.1.2.1.4.20.1.1.10.0.0.1 = IpAddress: 10.0.0.1");
        assert!(matches!(e.value, SnmpValue::IpAddress(ref s) if s == "10.0.0.1"));
    }

    #[test]
    fn parses_hex_string() {
        let e = first(".1.3.6.1.2.1.2.2.1.6.1 = Hex-STRING: 00 11 22 AA BB CC");
        match e.value {
            SnmpValue::OctetString(b) => assert_eq!(b, vec![0x00, 0x11, 0x22, 0xAA, 0xBB, 0xCC]),
            other => panic!("expected OctetString, got {other:?}"),
        }
    }

    #[test]
    fn parses_oid_value() {
        let e = first(".1.3.6.1.2.1.1.2.0 = OID: .1.3.6.1.4.1.9.1.1");
        assert!(matches!(e.value, SnmpValue::ObjectId(ref s) if s == "1.3.6.1.4.1.9.1.1"));
    }

    #[test]
    fn parses_no_such_object_marker() {
        let e = first(".1.3.6.1.2.1.1.5.0 = No Such Object available on this OID");
        assert!(matches!(e.value, SnmpValue::NoSuchObject));
    }

    #[test]
    fn parses_no_such_instance_marker() {
        let e = first(".1.3.6.1.2.1.1.5.999 = No Such Instance currently exists at this OID");
        assert!(matches!(e.value, SnmpValue::NoSuchInstance));
    }

    #[test]
    fn parses_end_of_mib_marker() {
        let e = first(
            ".1.3.6.1.2.1.99.99.99 = No more variables left in this MIB View (It is past the end of the MIB tree)"
        );
        assert!(matches!(e.value, SnmpValue::EndOfMibView));
    }

    #[test]
    fn parses_multi_entry_walk_output() {
        let raw = "\
.1.3.6.1.2.1.2.2.1.2.1 = STRING: GigabitEthernet0/0
.1.3.6.1.2.1.2.2.1.2.2 = STRING: GigabitEthernet0/1
.1.3.6.1.2.1.2.2.1.2.3 = STRING: Loopback0
";
        let entries = parse_snmp_output(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].oid, "1.3.6.1.2.1.2.2.1.2.1");
        assert!(matches!(&entries[2].value, SnmpValue::String(s) if s == "Loopback0"));
    }

    #[test]
    fn parses_multi_line_octet_string_continuation() {
        // OctetString containing a literal newline shows up as a continuation
        // line with no leading OID — must be folded into the previous value.
        let raw = "\
.1.3.6.1.2.1.25.6.3.1.2.1 = STRING: line1
line2
.1.3.6.1.2.1.25.6.3.1.2.2 = STRING: another
";
        let entries = parse_snmp_output(raw);
        assert_eq!(entries.len(), 2);
        match &entries[0].value {
            SnmpValue::String(s) => assert_eq!(s, "line1\nline2"),
            other => panic!("expected multi-line String, got {other:?}"),
        }
        assert!(matches!(&entries[1].value, SnmpValue::String(s) if s == "another"));
    }

    #[test]
    fn ignores_blank_lines_between_entries() {
        let raw = "\n\
.1.3.6.1.2.1.1.5.0 = STRING: a\n\
\n\
.1.3.6.1.2.1.1.5.1 = STRING: b\n";
        let entries = parse_snmp_output(raw);
        assert_eq!(entries.len(), 2);
    }
}
