use anyhow::{Context, Result, ensure};
use areal_protocol::service::Owner;
use std::{
    ffi::OsString,
    fs::File,
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
};
use tokio::io::unix::AsyncFd;

pub const OWNER_ENV: &str = "AREAL_GUI_OWNER";
pub const LIFETIME_FD_ENV: &str = "AREAL_GUI_LIFETIME_FD";
pub const SERVICE_OWNER_ENV: &str = "AREAL_SERVICE_OWNER";
pub const SERVICE_LIFETIME_FD_ENV: &str = "AREAL_SERVICE_LIFETIME_FD";

struct OwnerEnvironment {
    owner: Option<OsString>,
    lifetime_fd: Option<OsString>,
}

fn environment(mut get: impl FnMut(&str) -> Option<OsString>) -> Result<OwnerEnvironment> {
    let owner = get(SERVICE_OWNER_ENV);
    let lifetime_fd = get(SERVICE_LIFETIME_FD_ENV);
    let legacy_owner = get(OWNER_ENV);
    let legacy_lifetime_fd = get(LIFETIME_FD_ENV);
    ensure!(
        !(owner.is_some() || lifetime_fd.is_some())
            || !(legacy_owner.is_some() || legacy_lifetime_fd.is_some()),
        "service owner environment conflicts with legacy GUI owner environment"
    );
    Ok(OwnerEnvironment {
        owner: owner.or(legacy_owner),
        lifetime_fd: lifetime_fd.or(legacy_lifetime_fd),
    })
}

pub fn from_env() -> Result<Option<Owner>> {
    environment(|key| std::env::var_os(key))?
        .owner
        .map(|value| {
            parse_owner(
                value
                    .to_str()
                    .context("invalid service owner environment")?,
            )
        })
        .transpose()
}

pub fn parse_owner(value: &str) -> Result<Owner> {
    let owner: Owner = serde_json::from_str(value).context("invalid service owner")?;
    match &owner {
        Owner::Gui {
            app_run_id,
            profile,
        } => {
            uuid::Uuid::parse_str(app_run_id).context("GUI appRunId must be a UUID")?;
            ensure!(
                profile.is_absolute() && profile.is_dir() && profile.canonicalize()? == *profile,
                "GUI profile must be an absolute canonical directory"
            );
        }
        Owner::Host {
            host_id,
            generation,
        } => {
            uuid::Uuid::parse_str(host_id).context("Host hostId must be a UUID")?;
            uuid::Uuid::parse_str(generation).context("Host generation must be a UUID")?;
        }
    }
    Ok(owner)
}

pub fn check(expected: Option<&Owner>, actual: Option<&Owner>) -> Result<()> {
    ensure!(
        expected == actual,
        "service application owner mismatch; stop the original generation explicitly before starting another application session"
    );
    Ok(())
}

pub struct OwnerLifetime(AsyncFd<File>);

pub type GuiLifetime = OwnerLifetime;

/// 写端仅由生命周期 owner 持有，不向子进程提供继承入口。
pub struct LifetimeWriter {
    _fd: OwnedFd,
}

impl OwnerLifetime {
    pub fn pair() -> Result<(LifetimeWriter, Self)> {
        let (reader, writer) = std::io::pipe()?;
        let reader: OwnedFd = reader.into();
        let writer: OwnedFd = writer.into();
        Ok((LifetimeWriter { _fd: writer }, Self::from_owned(reader)?))
    }

    pub fn from_env() -> Result<Option<Self>> {
        environment(|key| std::env::var_os(key))?
            .lifetime_fd
            .map(|value| {
                let value = value
                    .to_str()
                    .context("invalid service lifetime environment")?;
                Self::claim(value.parse().context("invalid service lifetime fd")?)
            })
            .transpose()
    }

    fn claim(fd: RawFd) -> Result<Self> {
        ensure!(fd >= 3, "service lifetime requires a non-stdio descriptor");
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        ensure!(flags >= 0, "invalid inherited service lifetime descriptor");
        Self::from_owned(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn from_owned(fd: OwnedFd) -> Result<Self> {
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
        ensure!(
            flags >= 0
                && unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) }
                    >= 0,
            "could not prevent service lifetime descriptor inheritance"
        );
        let file = File::from(fd);
        let fd = file.as_raw_fd();
        let metadata = file.metadata()?;
        use std::os::unix::fs::FileTypeExt;
        ensure!(
            metadata.file_type().is_fifo() || metadata.file_type().is_socket(),
            "service lifetime descriptor must be a pipe or socket"
        );
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(
            flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0,
            "could not configure service lifetime descriptor"
        );
        Ok(Self(AsyncFd::new(file)?))
    }

    pub fn as_raw_fd(&self) -> RawFd {
        self.0.get_ref().as_raw_fd()
    }

    pub fn check_open(&self) -> Result<()> {
        let mut byte = 0u8;
        let count = unsafe { libc::read(self.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        if count < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
            return Ok(());
        }
        ensure!(count != 0, "service owner lifetime ended");
        anyhow::bail!("invalid service owner lifetime stream");
    }

    pub async fn closed(&self) -> Result<()> {
        loop {
            let mut ready = self.0.readable().await?;
            match ready.try_io(|inner| {
                let mut byte = 0u8;
                let count = unsafe {
                    libc::read(
                        inner.get_ref().as_raw_fd(),
                        (&mut byte as *mut u8).cast(),
                        1,
                    )
                };
                if count < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(count)
                }
            }) {
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(_)) => anyhow::bail!("unexpected data on service owner lifetime stream"),
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
