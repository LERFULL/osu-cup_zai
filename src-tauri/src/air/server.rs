//! Локальный сервер эфира: HTTP отдаёт страницу зрителя, WebSocket — состояние.
//!
//! Порт свободный, выбирается при старте. Слушаем только петлю: страницу
//! открывает OBS на этой же машине, и больше никто. Ни кода доступа, ни счёта
//! зрителей поэтому нет — считать некого, закрывать не от кого.
//!
//! Откуда берётся сама страница, зависит от того, как запущено приложение:
//! в сборке она лежит в ресурсах, после `pnpm build` — в `dist`, а в режиме
//! разработки её отдаёт Vite, и тогда сервер просто пропускает запросы к нему.
//! Без последнего эфир нельзя было бы посмотреть, не собрав приложение.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, oneshot};

use super::hub::AirHub;
use super::state::Wire;
use crate::error::{AppError, Result};

/// Порт Vite из `vite.config.ts`. Держать в двух местах плохо, но зависимости
/// у Rust от конфига сборки нет, а расхождение видно сразу — страница не откроется.
const DEV_ORIGIN: &str = "http://localhost:5180";

/// Пинг раз в 20 секунд: сокет, умерший без кадра закрытия, иначе висел бы
/// до таймаута TCP.
const PING_EVERY: Duration = Duration::from_secs(20);

/// Откуда брать файлы страницы зрителя.
#[derive(Clone)]
enum WebRoot {
    /// Собранная страница на диске.
    Dir(Arc<PathBuf>),
    /// Пропуск на сервер разработки.
    Dev(Arc<reqwest::Client>),
}

#[derive(Clone)]
struct Ctx {
    hub: Arc<AirHub>,
    root: WebRoot,
}

/// Поднятый сервер: порт и способ его погасить.
pub struct Running {
    pub port: u16,
    stop: Option<oneshot::Sender<()>>,
}

impl Running {
    /// Гасит сервер. Открытые соединения закрываются сами: зритель уже получил
    /// сообщение «эфир окончен» и держит последний кадр.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }
}

/// Поднимает сервер на свободном порту и возвращает его номер.
pub async fn start(app: &AppHandle, hub: Arc<AirHub>) -> Result<Running> {
    let root = resolve_root(app);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Other(format!("Порт для эфира не занялся: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Other(format!("Порт для эфира не читается: {e}")))?
        .port();

    let ctx = Ctx {
        hub: hub.clone(),
        root,
    };

    let router = Router::new()
        .route("/air", get(ws_handler))
        .fallback(get(page_handler))
        .with_state(ctx);

    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    // Пинг: сокет, умерший без кадра закрытия, иначе висел бы до таймаута TCP.
    let ticker = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(PING_EVERY).await;
            ticker.ping();
        }
    });

    tokio::spawn(async move {
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stop_rx.await;
            })
            .await;
        if let Err(e) = served {
            // Упавший сервер молчать не должен: пульт покажет это строкой.
            eprintln!("эфир: сервер остановился — {e}");
        }
    });

    Ok(Running {
        port,
        stop: Some(stop_tx),
    })
}

// ────────────────────────────────────────────────────────────── WebSocket

async fn ws_handler(State(ctx): State<Ctx>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| serve_viewer(socket, ctx))
}

async fn serve_viewer(socket: WebSocket, ctx: Ctx) {
    let mut rx = ctx.hub.subscribe();
    let (mut sink, mut stream) = socket.split();

    // Снимок — первое, что видит подключившийся: он попадает ровно туда,
    // где все остальные.
    let snapshot = Wire::Snapshot {
        state: ctx.hub.aired().await,
    };
    let mut alive = sink
        .send(Message::Text(snapshot.encode().into()))
        .await
        .is_ok();

    while alive {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Ok(text) => {
                    alive = sink.send(Message::Text(text.into())).await.is_ok();
                }
                // Зритель отстал от рассылки. Догонять нечем и незачем:
                // снимок дешевле и приводит его к тому же кадру, что у всех.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let snapshot = Wire::Snapshot { state: ctx.hub.aired().await };
                    alive = sink.send(Message::Text(snapshot.encode().into())).await.is_ok();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = stream.next() => match incoming {
                // Зритель ничего не присылает, кроме ответов на пинг.
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

// ─────────────────────────────────────────────────────────── страница

async fn page_handler(State(ctx): State<Ctx>, uri: Uri) -> Response {
    match &ctx.root {
        WebRoot::Dir(root) => from_disk(root, uri.path()),
        WebRoot::Dev(http) => from_dev(http, &uri).await,
    }
}

fn from_disk(root: &Path, path: &str) -> Response {
    // Корень — это страница зрителя, а не список файлов.
    let rel = if path == "/" { "air.html" } else { path.trim_start_matches('/') };

    // Выход за корень отрезаем по компонентам, а не поиском «..» в строке:
    // строку легко обойти кодированием, разбор пути — нет.
    let mut file = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            std::path::Component::Normal(name) => file.push(name),
            _ => return (StatusCode::NOT_FOUND, "нет такой страницы").into_response(),
        }
    }

    match std::fs::read(&file) {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime_of(&file))], bytes).into_response(),
        // Своих маршрутов у страницы нет, но перезагрузка по адресу вида
        // `/?code=X` должна открывать её же, а не «не найдено».
        Err(_) if !rel.contains('.') => match std::fs::read(root.join("air.html")) {
            Ok(bytes) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(),
            Err(_) => (StatusCode::NOT_FOUND, "страница эфира не собрана").into_response(),
        },
        Err(_) => (StatusCode::NOT_FOUND, "нет такого файла").into_response(),
    }
}

/// Пропуск на сервер разработки. Нужен ровно для того, чтобы эфир можно было
/// смотреть, не собирая приложение: адрес и туннель при этом настоящие.
async fn from_dev(http: &reqwest::Client, uri: &Uri) -> Response {
    let tail = match uri.path() {
        "/" => "/air.html".to_string(),
        path => match uri.query() {
            Some(q) => format!("{path}?{q}"),
            None => path.to_string(),
        },
    };

    let Ok(resp) = http.get(format!("{DEV_ORIGIN}{tail}")).send().await else {
        return (
            StatusCode::BAD_GATEWAY,
            "страница эфира не собрана, а сервер разработки не отвечает",
        )
            .into_response();
    };

    let status = resp.status();
    let ct = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let Ok(body) = resp.bytes().await else {
        return (StatusCode::BAD_GATEWAY, "ответ сервера разработки не дочитался").into_response();
    };

    (status, [(header::CONTENT_TYPE, ct)], body).into_response()
}

/// Тип по расширению. Без него браузер не исполнит модуль и не покажет шрифт.
fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Ищет собранную страницу. Порядок: ресурсы сборки, потом `dist` рядом с
/// проектом, и только если ничего нет — сервер разработки.
///
/// В сборке страница лежит в ресурсах (`bundle.resources` в `tauri.conf.json`)
/// именно потому, что её отдаёт этот сервер, а не вебвью: то, что Tauri вшил в
/// бинарник для своего окна, файлами на диске не является.
fn resolve_root(app: &AppHandle) -> WebRoot {
    let mut tries: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        tries.push(dir.join("air"));
        tries.push(dir.clone());
    }
    if let Ok(cwd) = std::env::current_dir() {
        // Приложение в разработке запускается из `src-tauri`, собранное — нет.
        tries.push(cwd.join("dist"));
        if let Some(parent) = cwd.parent() {
            tries.push(parent.join("dist"));
        }
    }

    for dir in tries {
        if dir.join("air.html").is_file() {
            return WebRoot::Dir(Arc::new(dir));
        }
    }

    WebRoot::Dev(Arc::new(reqwest::Client::new()))
}
