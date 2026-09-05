//! Обёртка для проверки чистой логики без tauri/GTK (генерируется скриптом).
#[path = "../../src/model.rs"] pub mod model;
#[path = "../../src/error.rs"] pub mod error;
#[path = "../../src/links.rs"] pub mod links;
#[path = "../../src/osu/mod.rs"] pub mod osu;
#[path = "../../src/prize/mod.rs"] pub mod prize;
#[path = "../../src/db/mod.rs"] pub mod db;
