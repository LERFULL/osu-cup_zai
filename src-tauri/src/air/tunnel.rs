//! Публичная ссылка: туннель наружу за одной абстракцией.
//!
//! Локальный сервер от выбора туннеля не зависит вовсе, поэтому они и разведены:
//! «отдать состояние зрителям» — одно, «сделать адрес доступным из интернета» —
//! другое. Сегодня реализаций две: только локально и локально плюс cloudflared.
//! Третья — свой релей — добавляется здесь же, не задевая ни сцен, ни состояния.
//!
//! Отдельно про проверку связи. У быстрого туннеля Cloudflare канал данных идёт
//! на порт **7844**, и он проходит далеко не везде: на машине со своим VPN-стеком
//! весь трафик уходит в TUN, а 7844 прокси не прокидывает. Ссылка при этом
//! выдаётся — живёт управляющий канал по 443, — а зритель не получает ничего.
//! Поэтому связь проверяется до эфира, а не выясняется посреди турнира.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{AppError, Result};

/// Как эфир выходит наружу.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// Только своя машина и локальная сеть. Для OBS этого достаточно.
    Local,
    /// Быстрый туннель Cloudflare: ссылка вида `*.trycloudflare.com`.
    Cloudflared,
}

/// Куда стучится канал данных быстрого туннеля.
const ARGO_HOST: &str = "region1.v2.argotunnel.com";
const ARGO_PORT: u16 = 7844;

/// Сколько ждём ссылку от cloudflared, прежде чем считать, что он не поднялся.
const URL_TIMEOUT: Duration = Duration::from_secs(25);

/// Сколько ждём, пока выданная ссылка начнёт отвечать. Cloudflare сам пишет
/// «it may take some time to be reachable», и это не фигура речи.
const REACH_TIMEOUT: Duration = Duration::from_secs(24);

/// Ссылка быстрого туннеля в выводе cloudflared.
///
/// Поддомен взят в группу нарочно. cloudflared регистрирует туннель через
/// `api.trycloudflare.com` и пишет этот адрес в свой же журнал — выражение без
/// проверки поддомена хватало его первым, и хосту выдавалась ссылка, по которой
/// открывается ответ API Cloudflare, а не эфир. Отрицания в `regex` нет, поэтому
/// поддомен проверяется кодом.
static URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https://([a-z0-9-]+)\.trycloudflare\.com").expect("постоянное выражение")
});

/// Служебные поддомены Cloudflare: эфира по ним нет.
const NOT_TUNNEL: &[&str] = &["api", "www"];

/// Вытаскивает адрес эфира из строки журнала. `None` — в строке его нет.
fn url_in(line: &str) -> Option<String> {
    for hit in URL_RE.captures_iter(line) {
        let host = hit.get(1)?.as_str();
        if NOT_TUNNEL.contains(&host) {
            continue;
        }
        return Some(hit.get(0)?.as_str().to_string());
    }
    None
}

/// Что показала проверка связи. Считается до запуска эфира.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// Бинарник cloudflared найден.
    pub binary: bool,
    /// Где именно он лежит.
    pub binary_path: Option<String>,
    /// Канал данных на порт 7844 проходит.
    pub data_channel: bool,
    /// Что делать, если не проходит. Пустая строка — всё в порядке.
    pub hint: String,
    /// Куда положить бинарник и откуда его взять.
    pub download_url: String,
    pub install_path: String,
}

/// Проверка связи целиком: есть ли чем поднимать туннель и пройдёт ли он.
pub async fn probe(data_dir: &Path) -> Probe {
    let binary = find_binary(data_dir);
    let data_channel = argo_reachable().await;

    let hint = if !data_channel {
        "Канал данных туннеля идёт на порт 7844, и здесь он не проходит. \
         Обычная причина — свой VPN: весь трафик уходит в туннель, а 7844 прокси \
         не прокидывает. Исключи из VPN подсети 198.41.192.0/24 и 198.41.200.0/24 \
         или сам cloudflared — либо веди эфир локально: для OBS публичная ссылка \
         не нужна вовсе."
            .to_string()
    } else if binary.is_none() {
        "Связь проходит, но нет самого cloudflared. Положи его по адресу ниже \
         или веди эфир локально."
            .to_string()
    } else {
        String::new()
    };

    Probe {
        binary: binary.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        data_channel,
        hint,
        download_url: release_url().to_string(),
        install_path: install_path(data_dir).to_string_lossy().to_string(),
    }
}

/// Проходит ли канал данных. Соединение устанавливаем и сразу бросаем: сам
/// факт установки TLS не проверяем, потому что перехват его и подделывает —
/// но недоступность порта видна уже здесь и стоит четыре секунды.
async fn argo_reachable() -> bool {
    let connect = tokio::net::TcpStream::connect((ARGO_HOST, ARGO_PORT));
    matches!(
        tokio::time::timeout(Duration::from_secs(4), connect).await,
        Ok(Ok(_))
    )
}

/// Имя файла под текущую систему.
fn binary_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

/// Официальная сборка последнего выпуска.
fn release_url() -> &'static str {
    if cfg!(windows) {
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    } else {
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    }
}

/// Куда кладём свою копию. Рядом с базой, а не в сборку: бинарник весит
/// десятки мегабайт, и тащить его в установщик ради необязательной функции незачем.
pub fn install_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(binary_name())
}

/// Ищет cloudflared: сначала свою копию, потом системную.
pub fn find_binary(data_dir: &Path) -> Option<PathBuf> {
    let own = install_path(data_dir);
    if own.is_file() {
        return Some(own);
    }

    // Системный ищем по PATH сами: `where` и `which` — это ещё один процесс
    // и ещё одно место, где всё может пойти не так.
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary_name()))
        .find(|candidate| candidate.is_file())
}

/// Скачивает бинарник в папку данных. Зовётся только по явному нажатию:
/// сама тянуть десятки мегабайт программа не должна.
pub async fn download(http: &reqwest::Client, data_dir: &Path) -> Result<String> {
    let target = install_path(data_dir);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let resp = http
        .get(release_url())
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Скачать cloudflared не вышло: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Сервер выдач ответил {} — попробуй позже",
            resp.status().as_u16()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("Файл не дочитался: {e}")))?;

    // Пишем через временный файл: обрыв не оставит половину бинарника,
    // который потом молча не запустится.
    let tmp = target.with_extension("part");
    std::fs::write(&tmp, &bytes)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }

    std::fs::rename(&tmp, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Запущенный туннель.
pub struct Running {
    child: Option<Child>,
    pub url: String,
}

impl Running {
    /// Гасит туннель. Ссылка после этого мертва — новая будет другой.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

/// Поднимает быстрый туннель на локальный порт и ждёт ссылку.
///
/// Ссылку cloudflared печатает в свой поток ошибок, а не в вывод, поэтому
/// читаем именно его. Заодно первые строки оттуда — это готовый текст
/// причины, если туннель не встал.
pub async fn start(binary: &Path, port: u16) -> Result<Running> {
    let mut command = Command::new(binary);
    command
        .arg("tunnel")
        .arg("--no-autoupdate")
        .arg("--url")
        .arg(format!("http://127.0.0.1:{port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Без этого на Windows на секунду выскакивает чёрное окно консоли.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| AppError::Other(format!("cloudflared не запустился: {e}")))?;

    let Some(stderr) = child.stderr.take() else {
        let _ = child.start_kill();
        return Err(AppError::Other(
            "cloudflared не отдал свой вывод — ссылку прочитать нечем".into(),
        ));
    };

    let mut lines = BufReader::new(stderr).lines();
    let mut tail: Vec<String> = Vec::new();

    let found = tokio::time::timeout(URL_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(hit) = url_in(&line) {
                return Some(hit);
            }
            // Держим хвост вывода: если ссылки не будет, он и есть объяснение.
            tail.push(line);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        None
    })
    .await;

    match found {
        Ok(Some(url)) => Ok(Running {
            child: Some(child),
            url,
        }),
        Ok(None) | Err(_) => {
            let _ = child.start_kill();
            let why = tail
                .iter()
                .rev()
                .find(|l| l.contains("ERR") || l.contains("error") || l.contains("failed"))
                .cloned()
                .unwrap_or_else(|| "cloudflared не выдал ссылку".to_string());
            Err(AppError::Other(format!(
                "Публичная ссылка не поднялась: {why}"
            )))
        }
    }
}

/// Отвечает ли выданная ссылка нашей же страницей.
///
/// Проверка нужна ровно потому, что ссылка выдаётся раньше, чем работает: у
/// быстрого туннеля управляющий канал идёт по 443, а данные — по 7844, и на
/// машине со своим VPN первый проходит, а второй нет. Без этой проверки хост
/// рассылал бы адрес, по которому зритель не получает ничего.
///
/// Отдельно ловим чужой ответ: если по адресу отвечает не наш сервер, это тоже
/// не эфир, каким бы бодрым ни был код ответа.
pub async fn reachable(http: &reqwest::Client, url: &str) -> std::result::Result<(), String> {
    let deadline = tokio::time::Instant::now() + REACH_TIMEOUT;
    let mut last = "ответа нет".to_string();

    while tokio::time::Instant::now() < deadline {
        match http
            .get(url)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let body = resp.text().await.unwrap_or_default();
                // Страница зрителя — это `air.html`, и в ней есть свой корень.
                if body.contains("id=\"air\"") || body.contains("id=air") {
                    return Ok(());
                }
                last = "по адресу отвечает не эфир".to_string();
            }
            Ok(resp) => last = format!("туннель ответил {}", resp.status().as_u16()),
            Err(e) if e.is_timeout() => last = "туннель не отвечает".to_string(),
            Err(e) => last = format!("туннель не отвечает: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    Err(last)
}

#[cfg(test)]
mod tests {
    use super::url_in;

    #[test]
    fn takes_quick_tunnel_url() {
        let line = "2026-08-16T12:00:00Z INF |  https://calm-river-holy-pine.trycloudflare.com  |";
        assert_eq!(
            url_in(line).as_deref(),
            Some("https://calm-river-holy-pine.trycloudflare.com")
        );
    }

    /// Та самая ошибка: по этому адресу открывается ответ API Cloudflare
    /// «Method Not Allowed», а не эфир.
    #[test]
    fn skips_registration_endpoint() {
        let line = "INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel";
        assert_eq!(url_in(line), None);
    }

    /// Служебный адрес и настоящий в одной строке: берём настоящий.
    #[test]
    fn takes_real_url_next_to_service_one() {
        let line = "ERR api.trycloudflare.com failed once, got https://api.trycloudflare.com \
                    then https://tiny-owl-plays-jazz.trycloudflare.com";
        assert_eq!(
            url_in(line).as_deref(),
            Some("https://tiny-owl-plays-jazz.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_lines_without_url() {
        assert_eq!(url_in("INF Starting tunnel tunnelID=abc"), None);
    }
}
