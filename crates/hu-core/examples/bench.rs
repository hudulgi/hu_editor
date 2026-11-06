//! Measures what a user feels on a big deck:
//!
//!     cargo run --release -p hu-core --example bench -- <file> [needle]
//!
//! Note: a file that was just generated sits in the OS page cache, so the
//! indexing and search rates are memory speed, not disk speed.

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use hu_core::{Document, FindOptions, Matching, ViewTarget};

const ROWS: usize = 60;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: bench <file> [needle]")?;
    let needle = args.next().unwrap_or_else(|| "NO-SUCH-TEXT-IN-DECK".into());

    let started = Instant::now();
    let doc = Document::open(&path)?;
    report("open", started.elapsed());
    let len = doc.len();
    println!("  size {:.2} GiB", gib(len));

    for (label, target) in [
        ("first page", ViewTarget::Fraction { fraction: 0.0 }),
        (
            "jump to middle (before index)",
            ViewTarget::Fraction { fraction: 0.5 },
        ),
        (
            "jump to end (before index)",
            ViewTarget::Fraction { fraction: 1.0 },
        ),
    ] {
        let started = Instant::now();
        let view = doc.view(target, ROWS)?;
        report(label, started.elapsed());
        println!(
            "  first line {:?}: {:?}",
            view.first_line, view.lines[0].text
        );
    }

    let started = Instant::now();
    let status = doc.wait_for_index();
    let elapsed = started.elapsed();
    report("line index", elapsed);
    println!(
        "  {} lines, {:.2} GiB/s",
        status.lines,
        gib(len) / elapsed.as_secs_f64()
    );

    let mut state = 0x2545_f491_4f6c_dd1du64;
    let samples = 1000;
    let mut worst = Duration::ZERO;
    let started = Instant::now();
    for _ in 0..samples {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let one = Instant::now();
        doc.view(
            ViewTarget::Line {
                line: state % status.lines,
            },
            ROWS,
        )?;
        worst = worst.max(one.elapsed());
    }
    report("random go-to-line (avg)", started.elapsed() / samples);
    report("random go-to-line (worst)", worst);

    let started = Instant::now();
    let mut scroll_top = 0;
    for _ in 0..1000 {
        scroll_top = doc
            .view(
                ViewTarget::Scroll {
                    anchor: scroll_top,
                    delta: 3,
                },
                ROWS,
            )?
            .top;
    }
    report("scroll 3 lines (avg)", started.elapsed() / 1000);

    for (case_sensitive, whole_word) in [(true, false), (false, false), (false, true)] {
        let started = Instant::now();
        let options = FindOptions {
            matching: Matching {
                case_sensitive,
                whole_word,
            },
            backward: false,
            wrap: true,
        };
        let result = doc.text().find(
            needle.as_bytes(),
            0,
            &options,
            &AtomicBool::new(false),
            &mut |_| {},
        )?;
        let elapsed = started.elapsed();
        let case = match (case_sensitive, whole_word) {
            (true, _) => "match case",
            (false, false) => "ignore case",
            (false, true) => "ignore case, whole word",
        };
        report(&format!("find {needle:?} ({case})"), elapsed);
        println!(
            "  {result:?}, {:.2} GiB/s",
            gib(len) / elapsed.as_secs_f64()
        );
    }
    Ok(())
}

fn report(label: &str, elapsed: Duration) {
    println!("{label:<32} {:>10.3} ms", elapsed.as_secs_f64() * 1e3);
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / (1u64 << 30) as f64
}
