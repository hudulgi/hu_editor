//! Core of hu_editor: an editor for very large solver input files (Abaqus,
//! Nastran).
//!
//! Large files are handled the way UltraEdit does it: the file is never
//! loaded as a whole. Blocks are read from disk on demand ([`source`]), line
//! numbers come from a sparse index built in the background
//! ([`line_index`]), and edits are a piece table over the untouched original
//! ([`pieces`]). Reads go through a [`Text`] snapshot addressed by byte
//! offset, so the viewport never waits for the index.

mod decode;
pub mod dir;
pub mod document;
mod history;
pub mod line_index;
mod original;
mod pieces;
pub mod search;
pub mod source;
pub mod text;

pub use decode::Encoding;
pub use document::{Change, DocState, Document, EditResult, Eol, MAX_COPY, MAX_REPLACE};
pub use history::EditKind;
pub use line_index::IndexStatus;
pub use search::{FindOptions, FindResult};
pub use text::{BoxLine, BoxRows, Text, View, ViewError, ViewLine, ViewTarget};
