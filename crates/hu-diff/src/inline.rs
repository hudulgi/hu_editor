//! What changed within a changed line. The lines are split into words
//! (numbers included, with their exponent), runs of blanks and single other
//! characters, and those are compared, so a changed number is marked whole
//! rather than the digits that differ.

use std::ops::Range;

use crate::myers;

/// Lines with more parts than this are not compared part by part.
const MAX_PARTS: usize = 4096;
const MAX_COST: usize = 512;

/// The byte ranges of `a` and of `b` that differ. Nothing for lines with too
/// little in common, where marks would only scatter: less than a third of
/// the characters other than blanks of the longer one.
pub fn inline(a: &[u8], b: &[u8]) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let (parts_a, parts_b) = (parts(a), parts(b));
    if parts_a.len() > MAX_PARTS || parts_b.len() > MAX_PARTS {
        return (Vec::new(), Vec::new());
    }
    let words_a: Vec<&[u8]> = parts_a.iter().map(|r| &a[r.clone()]).collect();
    let words_b: Vec<&[u8]> = parts_b.iter().map(|r| &b[r.clone()]).collect();
    let mut hunks = Vec::new();
    if !myers::hunks(&words_a, &words_b, MAX_COST, (0, 0), &mut hunks) {
        return (Vec::new(), Vec::new());
    }
    let solid = |words: &[&[u8]]| -> usize {
        words
            .iter()
            .filter(|w| !is_blank(w[0]))
            .map(|w| w.len())
            .sum()
    };
    let changed: usize = hunks
        .iter()
        .map(|h| solid(&words_a[h.a_start..h.a_end]))
        .sum();
    let common = solid(&words_a) - changed;
    if common * 3 < solid(&words_a).max(solid(&words_b)) {
        return (Vec::new(), Vec::new());
    }
    let ranges = |parts: &[Range<usize>], start: usize, end: usize| {
        (start < end).then(|| parts[start].start..parts[end - 1].end)
    };
    let marks_a = hunks
        .iter()
        .filter_map(|h| ranges(&parts_a, h.a_start, h.a_end))
        .collect();
    let marks_b = hunks
        .iter()
        .filter_map(|h| ranges(&parts_b, h.b_start, h.b_end))
        .collect();
    (marks_a, marks_b)
}

fn is_blank(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

/// Letters, digits, `_` and `.`, and anything not ASCII (part of a character
/// in another script).
fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c >= 0x80
}

/// The parts of a line, covering it.
fn parts(line: &[u8]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < line.len() {
        let start = i;
        i += 1;
        if is_word(line[start]) {
            while i < line.len() && (is_word(line[i]) || is_exponent_sign(&line[start..i], line[i]))
            {
                i += 1;
            }
        } else if is_blank(line[start]) {
            while i < line.len() && is_blank(line[i]) {
                i += 1;
            }
        }
        out.push(start..i);
    }
    out
}

/// `sign` goes on a number that ends in its exponent's letter: `1.5E` `+03`.
fn is_exponent_sign(word: &[u8], sign: u8) -> bool {
    (sign == b'+' || sign == b'-')
        && matches!(word.last(), Some(b'e' | b'E' | b'd' | b'D'))
        && word
            .first()
            .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
        && word[..word.len() - 1]
            .iter()
            .all(|c| c.is_ascii_digit() || *c == b'.')
}
