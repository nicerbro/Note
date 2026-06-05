#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
  fs,
  path::{Path, PathBuf},
  sync::Mutex,
};
use tauri::{
  image::Image,
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Manager, PhysicalPosition, PhysicalSize, State, Window,
};
use tauri_runtime::ResizeDirection;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const NOTES_FILE: &str = "notes.json";
const TASKS_FILE: &str = "tasks.json";
const SETTINGS_FILE: &str = "app-settings.json";

#[derive(Default)]
struct MoveState(Mutex<Option<MoveSnapshot>>);

#[derive(Default)]
struct ResizeState(Mutex<Option<ResizeSnapshot>>);

#[derive(Clone, Copy)]
struct MoveSnapshot {
  offset_x: f64,
  offset_y: f64,
}

#[derive(Clone)]
struct ResizeSnapshot {
  edge: String,
  start_x: f64,
  start_y: f64,
  x: i32,
  y: i32,
  width: u32,
  height: u32,
}

#[derive(Deserialize)]
struct ScreenPoint {
  x: f64,
  y: f64,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|path| path.join("data"))
}

fn note_resources_dir(app: &tauri::AppHandle, note_id: &str) -> Result<PathBuf, String> {
  let safe_note_id = safe_path_segment(note_id);
  data_dir(app).map(|path| path.join("note-resources").join(safe_note_id))
}

fn safe_path_segment(value: &str) -> String {
  let safe: String = value
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
        character
      } else {
        '_'
      }
    })
    .collect();

  let trimmed = safe.trim_matches('.').trim_matches('_');
  if trimmed.is_empty() {
    "asset".to_string()
  } else {
    trimmed.to_string()
  }
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
  match fs::read_to_string(path) {
    Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|error| error.to_string()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.to_string()),
  }
}

fn legacy_project_data_dir() -> Option<PathBuf> {
  std::env::current_dir()
    .ok()
    .map(|path| path.join("data"))
    .filter(|path| path.join(NOTES_FILE).exists() || path.join(TASKS_FILE).exists() || path.join(SETTINGS_FILE).exists())
}

fn load_from_dir(dir: &Path) -> Result<Option<Value>, String> {
  let notes = read_json(&dir.join(NOTES_FILE))?;
  let tasks = read_json(&dir.join(TASKS_FILE))?;
  let settings = read_json(&dir.join(SETTINGS_FILE))?;

  if notes.is_none() && tasks.is_none() && settings.is_none() {
    return Ok(None);
  }

  let mut state = settings.unwrap_or_else(|| json!({}));
  if let Some(object) = state.as_object_mut() {
    object.insert("notes".to_string(), notes.unwrap_or_else(|| json!([])));
    object.insert("tasks".to_string(), tasks.unwrap_or_else(|| json!([])));
  }

  Ok(Some(state))
}

fn write_json(path: &Path, data: &Value) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }

  let temp_path = path.with_extension("json.tmp");
  let raw = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
  fs::write(&temp_path, raw).map_err(|error| error.to_string())?;
  fs::rename(&temp_path, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn storage_load(app: tauri::AppHandle) -> Result<Option<Value>, String> {
  let dir = data_dir(&app)?;
  if let Some(state) = load_from_dir(&dir)? {
    return Ok(Some(state));
  }

  if let Some(legacy_dir) = legacy_project_data_dir() {
    if let Some(state) = load_from_dir(&legacy_dir)? {
      storage_save(app, state.clone())?;
      return Ok(Some(state));
    }
  }

  Ok(None)
}

#[tauri::command]
fn storage_save(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
  let dir = data_dir(&app)?;
  let notes = data.get("notes").cloned().unwrap_or_else(|| json!([]));
  let tasks = data.get("tasks").cloned().unwrap_or_else(|| json!([]));
  let mut settings = data;

  if let Some(object) = settings.as_object_mut() {
    object.remove("notes");
    object.remove("tasks");
  }

  write_json(&dir.join(NOTES_FILE), &notes)?;
  write_json(&dir.join(TASKS_FILE), &tasks)?;
  write_json(&dir.join(SETTINGS_FILE), &settings)?;
  Ok(true)
}

#[tauri::command]
fn note_image_save(
  app: tauri::AppHandle,
  note_id: String,
  file_name: String,
  data_url: String,
) -> Result<Value, String> {
  let comma_index = data_url
    .find(',')
    .ok_or_else(|| "Invalid image data URL.".to_string())?;
  let header = &data_url[..comma_index];
  let encoded = &data_url[comma_index + 1..];
  if !header.starts_with("data:image/") || !header.contains(";base64") {
    return Err("Only base64 image data URLs are supported.".to_string());
  }

  let extension = header
    .trim_start_matches("data:image/")
    .split(';')
    .next()
    .unwrap_or("png");
  let extension = match extension {
    "jpeg" => "jpg",
    "png" | "jpg" | "gif" | "webp" | "svg+xml" => extension,
    _ => "png",
  };
  let extension = if extension == "svg+xml" { "svg" } else { extension };
  let stem = Path::new(&file_name)
    .file_stem()
    .and_then(|value| value.to_str())
    .map(safe_path_segment)
    .unwrap_or_else(|| "image".to_string());
  let stored_name = format!("{}-{}.{}", chrono_like_timestamp(), stem, extension);
  let dir = note_resources_dir(&app, &note_id)?;
  fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
  let bytes = general_purpose::STANDARD
    .decode(encoded)
    .map_err(|error| error.to_string())?;
  fs::write(dir.join(&stored_name), bytes).map_err(|error| error.to_string())?;

  Ok(json!({
    "id": stored_name,
    "name": file_name,
    "fileName": stored_name,
    "markdownPath": format!("note-resource://{}/{}", safe_path_segment(&note_id), stored_name),
    "src": data_url
  }))
}

#[tauri::command]
fn note_image_load(app: tauri::AppHandle, note_id: String, file_name: String) -> Result<String, String> {
  let safe_name = safe_path_segment(&file_name);
  let path = note_resources_dir(&app, &note_id)?.join(safe_name);
  let bytes = fs::read(&path).map_err(|error| error.to_string())?;
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("png")
    .to_lowercase();
  let mime = match extension.as_str() {
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "svg" => "image/svg+xml",
    _ => "image/png",
  };
  Ok(format!(
    "data:{};base64,{}",
    mime,
    general_purpose::STANDARD.encode(bytes)
  ))
}

fn chrono_like_timestamp() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or(0)
}

#[tauri::command]
fn window_set_always_on_top(window: Window, enabled: bool) -> Result<bool, String> {
  window
    .set_always_on_top(enabled)
    .map_err(|error| error.to_string())?;
  Ok(enabled)
}

#[tauri::command]
fn window_hide(window: Window) -> Result<bool, String> {
  window.hide().map_err(|error| error.to_string())?;
  Ok(true)
}

#[tauri::command]
fn window_start_dragging(window: Window) -> Result<bool, String> {
  window.start_dragging().map_err(|error| error.to_string())?;
  Ok(true)
}

#[tauri::command]
fn window_start_resize_dragging(window: Window, edge: String) -> Result<bool, String> {
  let direction = match edge.as_str() {
    "n" => ResizeDirection::North,
    "e" => ResizeDirection::East,
    "s" => ResizeDirection::South,
    "w" => ResizeDirection::West,
    "ne" => ResizeDirection::NorthEast,
    "se" => ResizeDirection::SouthEast,
    "sw" => ResizeDirection::SouthWest,
    "nw" => ResizeDirection::NorthWest,
    _ => return Ok(false),
  };
  window.start_resize_dragging(direction).map_err(|error| error.to_string())?;
  Ok(true)
}

#[tauri::command]
fn window_begin_move(
  window: Window,
  state: State<MoveState>,
  point: ScreenPoint,
) -> Result<bool, String> {
  let position = window.outer_position().map_err(|error| error.to_string())?;
  let mut move_state = state.0.lock().map_err(|error| error.to_string())?;
  *move_state = Some(MoveSnapshot {
    offset_x: point.x - f64::from(position.x),
    offset_y: point.y - f64::from(position.y),
  });
  Ok(true)
}

#[tauri::command]
fn window_move_to(
  window: Window,
  state: State<MoveState>,
  point: ScreenPoint,
) -> Result<bool, String> {
  let move_state = state.0.lock().map_err(|error| error.to_string())?;
  let Some(snapshot) = *move_state else {
    return Ok(false);
  };

  window
    .set_position(PhysicalPosition::new(
      (point.x - snapshot.offset_x).round() as i32,
      (point.y - snapshot.offset_y).round() as i32,
    ))
    .map_err(|error| error.to_string())?;
  Ok(true)
}

#[tauri::command]
fn window_end_move(state: State<MoveState>) -> Result<bool, String> {
  let mut move_state = state.0.lock().map_err(|error| error.to_string())?;
  *move_state = None;
  Ok(true)
}

#[tauri::command]
fn window_begin_resize(
  window: Window,
  state: State<ResizeState>,
  edge: String,
  point: ScreenPoint,
) -> Result<bool, String> {
  let position = window.outer_position().map_err(|error| error.to_string())?;
  let size = window.outer_size().map_err(|error| error.to_string())?;
  let mut resize_state = state.0.lock().map_err(|error| error.to_string())?;
  *resize_state = Some(ResizeSnapshot {
    edge,
    start_x: point.x,
    start_y: point.y,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  });
  Ok(true)
}

#[tauri::command]
fn window_resize_to(
  window: Window,
  state: State<ResizeState>,
  point: ScreenPoint,
) -> Result<bool, String> {
  let resize_state = state.0.lock().map_err(|error| error.to_string())?;
  let Some(snapshot) = resize_state.as_ref() else {
    return Ok(false);
  };

  let dx = point.x - snapshot.start_x;
  let dy = point.y - snapshot.start_y;
  let mut next_x = snapshot.x;
  let mut next_y = snapshot.y;
  let mut next_width = f64::from(snapshot.width);
  let mut next_height = f64::from(snapshot.height);

  if snapshot.edge.contains('e') {
    next_width = (f64::from(snapshot.width) + dx).max(360.0);
  }
  if snapshot.edge.contains('s') {
    next_height = (f64::from(snapshot.height) + dy).max(500.0);
  }
  if snapshot.edge.contains('w') {
    next_width = (f64::from(snapshot.width) - dx).max(360.0);
    next_x = snapshot.x + snapshot.width as i32 - next_width.round() as i32;
  }
  if snapshot.edge.contains('n') {
    next_height = (f64::from(snapshot.height) - dy).max(500.0);
    next_y = snapshot.y + snapshot.height as i32 - next_height.round() as i32;
  }

  window
    .set_position(PhysicalPosition::new(next_x, next_y))
    .map_err(|error| error.to_string())?;
  window
    .set_size(PhysicalSize::new(
      next_width.round() as u32,
      next_height.round() as u32,
    ))
    .map_err(|error| error.to_string())?;
  Ok(true)
}

#[tauri::command]
fn window_end_resize(state: State<ResizeState>) -> Result<bool, String> {
  let mut resize_state = state.0.lock().map_err(|error| error.to_string())?;
  *resize_state = None;
  Ok(true)
}

fn toggle_main_window(app: &tauri::AppHandle) {
  let Some(window) = app.get_webview_window("main") else {
    return;
  };

  match window.is_visible() {
    Ok(true) => {
      match window.is_focused() {
        Ok(true) => {
          let _ = window.hide();
        }
        _ => {
          let _ = window.unminimize();
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
    }
    Ok(false) => {
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
    }
    Err(error) => {
      eprintln!("Failed to read main window visibility: {error}");
    }
  }
}

fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let show_hide = MenuItem::with_id(app, "show-hide", "显示/隐藏", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show_hide, &quit])?;
  let icon = Image::from_bytes(include_bytes!("../../assets/images/app-tray.ico"))?;

  TrayIconBuilder::with_id("main-tray")
    .tooltip("浮空笔记")
    .icon(icon)
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show-hide" => toggle_main_window(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_main_window(tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}

fn setup_shortcuts(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyN);
  app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
    if event.state() == ShortcutState::Pressed {
      toggle_main_window(app);
    }
  })?;
  Ok(())
}

fn apply_initial_window_size(app: &tauri::AppHandle) {
  let Some(window) = app.get_webview_window("main") else {
    return;
  };
  let size = PhysicalSize::new(902, 1128);
  let _ = window.set_min_size(Some(size));
  let _ = window.set_size(size);
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .manage(MoveState::default())
    .manage(ResizeState::default())
    .setup(|app| {
      apply_initial_window_size(app.handle());
      setup_tray(app.handle())?;
      setup_shortcuts(app.handle())?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      storage_load,
      storage_save,
      note_image_save,
      note_image_load,
      window_set_always_on_top,
      window_hide,
      window_start_dragging,
      window_start_resize_dragging,
      window_begin_move,
      window_move_to,
      window_end_move,
      window_begin_resize,
      window_resize_to,
      window_end_resize
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
