//! Telling Abaqus from Nastran by content, for file extensions that users of
//! both solvers use (`.blk`).

use std::cmp::Ordering;

use serde::Serialize;

/// Lead in votes at which the rest of the sample cannot change the answer in
/// any realistic deck.
const DECISIVE_LEAD: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    Abaqus,
    Nastran,
}

/// Which solver the start of a file looks written for: each line that is
/// typical of one solver votes for it. `None` if no line says anything or
/// the votes tie.
pub fn detect(sample: &[u8]) -> Option<Dialect> {
    let (mut abaqus, mut nastran) = (0u32, 0u32);
    for line in sample.split(|&b| b == b'\n') {
        match vote(line) {
            Some(Dialect::Abaqus) => abaqus += 1,
            Some(Dialect::Nastran) => nastran += 1,
            None => {}
        }
        if abaqus.abs_diff(nastran) >= DECISIVE_LEAD {
            break;
        }
    }
    match abaqus.cmp(&nastran) {
        Ordering::Greater => Some(Dialect::Abaqus),
        Ordering::Less => Some(Dialect::Nastran),
        Ordering::Equal => None,
    }
}

fn vote(line: &[u8]) -> Option<Dialect> {
    let line = line.trim_ascii_end();
    match line.first()? {
        b'$' => return Some(Dialect::Nastran),
        // `**` comments and `*Keyword`, but not a large-field continuation
        // of Nastran (`*       0.` or `*G1     0.`).
        b'*' if line.get(1) == Some(&b'*') || is_keyword(&line[1..]) => {
            return Some(Dialect::Abaqus);
        }
        b'*' => return None,
        _ => {}
    }
    let end = line
        .iter()
        .position(|b| b.is_ascii_whitespace() || *b == b',')
        .unwrap_or(line.len());
    if is_card(&line[..end]) {
        return Some(Dialect::Nastran);
    }
    // Data lines of an Abaqus include start with a number and a comma; a
    // Nastran line never does (free field starts with a card or a comma).
    let comma = line.iter().position(|&b| b == b',')?;
    is_number(line[..comma].trim_ascii()).then_some(Dialect::Abaqus)
}

/// The text after `*` is a keyword: letters, spaces and hyphens up to the
/// first comma (`Node`, `End Part`, `Element, type=C3D8R`).
fn is_keyword(rest: &[u8]) -> bool {
    let name = rest.split(|&b| b == b',').next().unwrap_or_default();
    name.first().is_some_and(u8::is_ascii_alphabetic)
        && name
            .iter()
            .all(|b| b.is_ascii_alphabetic() || matches!(b, b' ' | b'-'))
}

fn is_number(field: &[u8]) -> bool {
    field.iter().any(u8::is_ascii_digit)
        && field.iter().all(|b| {
            b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E' | b'd' | b'D')
        })
}

/// A common Nastran bulk or control entry; `GRID*` is the large-field form.
fn is_card(token: &[u8]) -> bool {
    let name = token.strip_suffix(b"*").unwrap_or(token);
    name.len() <= 8
        && CARDS
            .iter()
            .any(|card| card.as_bytes().eq_ignore_ascii_case(name))
}

const CARDS: &[&str] = &[
    "BEGIN", "CEND", "ENDDATA", "INCLUDE", "SOL", "PARAM", "GRID", "GRDSET", "SPOINT", "EPOINT",
    "CORD1C", "CORD1R", "CORD1S", "CORD2C", "CORD2R", "CORD2S", "CBAR", "CBEAM", "CBEND", "CBUSH",
    "CBUSH1D", "CFAST", "CGAP", "CHEXA", "CONM1", "CONM2", "CONROD", "CPENTA", "CPYRAM", "CQUAD4",
    "CQUAD8", "CQUADR", "CROD", "CSHEAR", "CTETRA", "CTRIA3", "CTRIA6", "CTRIAR", "CTUBE", "CVISC",
    "CWELD", "PLOTEL", "CDAMP1", "CDAMP2", "CDAMP3", "CDAMP4", "CDAMP5", "CELAS1", "CELAS2",
    "CELAS3", "CELAS4", "CMASS1", "CMASS2", "CMASS3", "CMASS4", "RBAR", "RBAR1", "RBE1", "RBE2",
    "RBE3", "RROD", "RSPLINE", "PBAR", "PBARL", "PBEAM", "PBEAML", "PBUSH", "PCOMP", "PCOMPG",
    "PDAMP", "PELAS", "PFAST", "PGAP", "PMASS", "PROD", "PSHEAR", "PSHELL", "PSOLID", "PTUBE",
    "PVISC", "PWELD", "MAT1", "MAT2", "MAT3", "MAT4", "MAT5", "MAT8", "MAT9", "MATS1", "MATT1",
    "FORCE", "FORCE1", "FORCE2", "MOMENT", "MOMENT1", "MOMENT2", "GRAV", "LOAD", "PLOAD", "PLOAD1",
    "PLOAD2", "PLOAD4", "RFORCE", "TEMP", "TEMPD", "SPC", "SPC1", "SPCADD", "SPCD", "MPC",
    "MPCADD", "DLOAD", "TLOAD1", "TLOAD2", "RLOAD1", "RLOAD2", "DAREA", "EIGR", "EIGRL", "TSTEP",
    "NLPARM", "FREQ", "FREQ1", "TABDMP1", "TABLED1", "TABLED2", "TABLEM1", "TABLES1", "BCTABLE",
    "BSURF", "BSURFS",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abaqus_decks() {
        for deck in [
            "*Heading\n** comment\n*Node\n1, 0., 0., 0.\n",
            "** only a comment\n",
            "*ELEMENT, TYPE=C3D8R, ELSET=BLOCK\n1, 1, 2, 3, 4, 5, 6, 7, 8\n",
            "*End Part\n",
            "*COUPLED TEMPERATURE-DISPLACEMENT\n",
            // A data-only include, as in `*Node, input=nodes.blk`.
            "1, 0., 0., 0.\n2, 1.5e-3, -2., +3.\n",
            "   100,  0.0,  0.0\n",
            "*Heading\nLOAD CASE 1\n*Node\n1, 0., 0., 0.\n",
        ] {
            assert_eq!(detect(deck.as_bytes()), Some(Dialect::Abaqus), "{deck:?}");
        }
    }

    #[test]
    fn nastran_decks() {
        for deck in [
            "$ comment\nGRID    1       0.      0.      0.\n",
            "$ only a comment\n",
            "SOL 101\nCEND\nBEGIN BULK\n",
            "CQUAD4  1       1       1       2       3       4\n",
            "grid    1\n",
            "GRID,1,,0.,0.,0.\n",
            ",1,2,3\nCHEXA,1,1,1,2,3,4,5,6\n",
            // Large field: the continuations look a little like keywords.
            "GRID*                  1                              0.              0.\n*                     0.\n",
            "GRID*                  1                              0.              0.*G1\n*G1                   0.\n",
        ] {
            assert_eq!(detect(deck.as_bytes()), Some(Dialect::Nastran), "{deck:?}");
        }
    }

    #[test]
    fn says_nothing_without_evidence() {
        for deck in [
            "",
            "\n\n",
            "just some notes\nmore notes\n",
            "$ a\n** b\n",
            "1\n2\n3\n",
        ] {
            assert_eq!(detect(deck.as_bytes()), None, "{deck:?}");
        }
    }

    #[test]
    fn line_breaks_and_encodings_do_not_matter() {
        assert_eq!(detect(b"*Node\r\n1, 0., 0., 0.\r\n"), Some(Dialect::Abaqus));
        assert_eq!(
            detect(b"$ \xC7\xD1\xB1\xDB\r\nGRID    1\r\n"),
            Some(Dialect::Nastran)
        );
    }

    #[test]
    fn the_majority_wins() {
        // A heading mentioning a card does not outvote the keywords around it.
        assert_eq!(
            detect(b"*Heading\nFORCE test\n*Node\n"),
            Some(Dialect::Abaqus)
        );
        // An Abaqus-looking line inside a Nastran deck does not either.
        assert_eq!(
            detect(b"$ a\nGRID    1\n1, 2\nGRID    2\n"),
            Some(Dialect::Nastran)
        );
    }

    #[test]
    fn stops_once_it_is_clear() {
        let mut deck = "GRID    1\n".repeat(DECISIVE_LEAD as usize).into_bytes();
        deck.extend("*Node\n".repeat(200).into_bytes());
        assert_eq!(detect(&deck), Some(Dialect::Nastran));
    }
}
