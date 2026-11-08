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
pub mod dialect;
pub mod dir;
pub mod document;
pub mod files;
mod history;
pub mod line_index;
pub mod markdown;
mod original;
mod pattern;
mod pieces;
mod problem;
pub mod query;
pub mod search;
pub mod settings;
pub mod source;
pub mod text;

pub use decode::Encoding;
pub use dialect::Dialect;
pub use document::{
    BlockKind, Change, DocState, Document, EditResult, Eol, MAX_COPY, MAX_MARKS, MAX_REPLACE,
};
pub use history::EditKind;
pub use line_index::IndexStatus;
pub use problem::{Problem, ipc_message};
pub use query::{MatchCount, Query};
pub use search::{FindOptions, FindResult, Matching};
pub use text::{BoxLine, BoxRows, Text, View, ViewLine, ViewTarget};
