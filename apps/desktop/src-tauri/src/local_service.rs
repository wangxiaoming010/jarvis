use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Clone, Deserialize, Serialize)]
pub struct Connection {
    url: String,
    token: String,
}

struct Host {
    child: Child,
    connection: Connection,
}

#[derive(Clone, Default)]
pub struct LocalService(Arc<Mutex<Option<Host>>>);

impl LocalService {
    fn connect(&self, resources: PathBuf, directory: PathBuf) -> Result<Connection, String> {
        let mut current = self.0.lock().map_err(|_| "本地服务暂时无法启动")?;
        if let Some(host) = current.as_mut() {
            if matches!(host.child.try_wait(), Ok(None)) {
                return Ok(host.connection.clone());
            }
            *current = None;
        }
        fs::create_dir_all(&directory).map_err(|_| "无法准备本地数据，请检查磁盘空间")?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("service.log"))
            .map_err(|_| "无法保存本地运行记录")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = log.set_permissions(fs::Permissions::from_mode(0o600));
        }
        let executable =
            resources
                .join("bin")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut command = Command::new(executable);
        command
            .arg(resources.join("host.mjs"))
            .env("OPENBOT_DATA_DIR", &directory)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动内置服务，请重新安装 Personal OpenBot Group")?;
        let output = child.stdout.take().ok_or("无法读取本地服务状态")?;
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(connection) = serde_json::from_str::<Connection>(&line) {
                    let _ = send.send(connection);
                }
            }
        });
        match receive.recv_timeout(Duration::from_secs(25)) {
            Ok(connection)
                if connection.url.starts_with("http://127.0.0.1:")
                    && connection.token.len() >= 24 =>
            {
                *current = Some(Host {
                    child,
                    connection: connection.clone(),
                });
                Ok(connection)
            }
            _ => {
                stop(&mut child);
                Err("本地服务启动失败，请点击重试或重新打开 Personal OpenBot Group".into())
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut current) = self.0.lock() {
            if let Some(mut host) = current.take() {
                stop(&mut host.child);
            }
        }
    }
}

fn stop(child: &mut Child) {
    // Closing the parent pipe asks the host to finish its Bridge and close SQLite.
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
pub async fn local_service(
    app: tauri::AppHandle,
    service: tauri::State<'_, LocalService>,
) -> Result<Connection, String> {
    // The development launcher already owns the source server and Bridge.
    #[cfg(debug_assertions)]
    {
        if let (Ok(url), Ok(token)) = (
            std::env::var("VITE_SERVER_URL"),
            std::env::var("VITE_OPENBOT_TOKEN"),
        ) {
            if url.starts_with("http://127.0.0.1:") && token.len() >= 24 {
                return Ok(Connection { url, token });
            }
        }
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "无法读取应用资源")?
        .join("runtime");
    let directory = app.path().app_data_dir().map_err(|_| "无法准备本地数据")?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.connect(resources, directory))
        .await
        .map_err(|_| "本地服务启动中断，请重试".to_string())?
}
