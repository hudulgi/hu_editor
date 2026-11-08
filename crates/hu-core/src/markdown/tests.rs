use std::io::Write;

use super::*;

#[test]
fn headings_get_ids_links_can_reach() {
    let html =
        to_html("# Load steps\n\n## Load steps\n\n## 하중 *조건* `CLOAD`\n\n## What's new?\n");
    assert!(html.contains(r#"<h1 id="md-load-steps">"#), "{html}");
    assert!(html.contains(r#"<h2 id="md-load-steps-1">"#), "{html}");
    assert!(html.contains(r#"<h2 id="md-하중-조건-cload">"#), "{html}");
    assert!(html.contains(r#"<h2 id="md-whats-new">"#), "{html}");
}

#[test]
fn github_flavour() {
    let html = to_html(
        "| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] not yet\n\n~~gone~~ and a note[^1]\n\n[^1]: The note.\n\n> [!WARNING]\n> Careful.\n",
    );
    assert!(html.contains("<table>"), "{html}");
    assert!(
        html.contains(r#"<td style="text-align:center">2</td>"#),
        "{html}"
    );
    assert_eq!(html.matches(r#"type="checkbox""#).count(), 2, "{html}");
    assert_eq!(html.matches("disabled").count(), 2, "{html}");
    assert_eq!(html.matches("checked").count(), 1, "{html}");
    assert!(html.contains("<del>gone</del>"), "{html}");
    assert!(
        html.contains(r##"href="#1""##) && html.contains(r#"id="md-1""#),
        "{html}"
    );
    assert!(
        html.contains(r#"<blockquote class="markdown-alert-warning">"#),
        "{html}"
    );
}

#[test]
fn html_that_shows_stays() {
    let html = to_html(
        "<p align=\"center\"><img src=\"logo.png\" width=\"80\" alt=\"logo\"></p>\n\n<details><summary>More</summary>\n\nHidden <kbd>Ctrl</kbd>+<kbd>K</kbd><br>text\n\n</details>\n",
    );
    for kept in [
        r#"<p align="center">"#,
        r#"src="logo.png""#,
        r#"width="80""#,
        "<details><summary>More</summary>",
        "<kbd>Ctrl</kbd>",
        "<br>",
    ] {
        assert!(html.contains(kept), "{kept} in {html}");
    }
}

#[test]
fn nothing_runs() {
    let html = to_html(concat!(
        "<script>alert(1)</script>\n\n",
        "<img src=x onerror=\"alert(2)\">\n\n",
        "[click](javascript:alert(3)) <a href=\"javascript:alert(4)\">a</a>\n\n",
        "<iframe src=\"https://example.com\"></iframe>\n\n",
        "<style>body { display: none }</style>\n\n",
        "<div style=\"position: fixed\" class=\"pane focused\" data-pane=\"0\" onclick=\"alert(5)\">x</div>\n\n",
        "<table><tr><td style=\"position: fixed; top: 0\">cell</td></tr></table>\n\n",
        "<form action=\"/\"><input type=\"text\" name=\"q\"><button>Go</button></form>\n\n",
        "<object data=\"x.swf\"></object><embed src=\"x.swf\"><svg onload=\"alert(6)\"></svg>\n",
    ));
    for gone in [
        "<script",
        "alert",
        "javascript",
        "<iframe",
        "<style",
        "display",
        "position",
        "class=",
        "data-pane",
        "<form",
        "<button",
        r#"type="text""#,
        "<object",
        "<embed",
        "<svg",
    ] {
        assert!(!html.contains(gone), "{gone} in {html}");
    }
    assert!(
        html.contains("disabled"),
        "a box left is still not to be typed in: {html}"
    );
}

#[test]
fn links_keep_where_they_go() {
    let html = to_html(
        "[guide](docs/guide.md#steps) [site](https://example.com) [up](../a.inp) [top](#load-steps)\n",
    );
    for href in [
        "docs/guide.md#steps",
        "https://example.com",
        "../a.inp",
        "#load-steps",
    ] {
        assert!(
            html.contains(&format!(r#"href="{href}""#)),
            "{href} in {html}"
        );
    }
}

#[test]
fn previews_a_document_up_to_a_size() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all("# 제목\n\n본문 *강조*\n".as_bytes())
        .unwrap();
    file.flush().unwrap();
    let doc = Document::open(file.path()).unwrap();
    let html = preview(&doc).unwrap();
    assert!(html.contains(r#"<h1 id="md-제목">제목</h1>"#), "{html}");
    assert!(html.contains("<em>강조</em>"), "{html}");

    let big = tempfile::NamedTempFile::new().unwrap();
    big.as_file().set_len(MAX_PREVIEW + 1).unwrap();
    let error = preview(&Document::open(big.path()).unwrap()).unwrap_err();
    assert_eq!(
        crate::ipc_message(&error),
        r#"{"code":"tooLargeToPreview","sizeMb":17,"limitMb":16}"#
    );
}

#[test]
fn images_as_data() {
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("Logo.PNG");
    std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
    assert_eq!(image_data(&png).unwrap(), "data:image/png;base64,iVBORw==");
    let text = dir.path().join("notes.txt");
    std::fs::write(&text, "x").unwrap();
    assert_eq!(
        image_data(&text).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        image_data(&dir.path().join("gone.png")).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn web_links() {
    for url in [
        "https://example.com",
        "HTTP://example.com",
        "mailto:a@example.com",
    ] {
        assert!(is_web_link(url), "{url}");
    }
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "C:\\Windows\\notepad.exe",
        "docs/a.md",
        "ms-settings:",
    ] {
        assert!(!is_web_link(url), "{url}");
    }
}
