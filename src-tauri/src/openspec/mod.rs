//! Reading OpenSpec projects.

pub mod cli;
pub mod fs_scan;
pub mod model;
pub mod schema;
pub mod source;
pub mod tree;

pub use model::*;
pub use source::load;
