//! Core of hu_editor: disk-backed documents for very large solver input
//! files (Abaqus, Nastran).
//!
//! Large files are handled the way UltraEdit does it: the file is never
//! loaded as a whole. Blocks are read from disk on demand ([`source`]), line
//! numbers come from a sparse index built in the background
//! ([`line_index`]), and the viewport is addressed by byte offset so it never
//! waits for that index ([`document`]).

pub mod dir;
pub mod document;
pub mod line_index;
pub mod search;
pub mod source;
mod text;

pub use document::{Document, Mark, View, ViewError, ViewLine, ViewTarget};
pub use line_index::IndexStatus;
pub use search::{FindOptions, FindResult};
