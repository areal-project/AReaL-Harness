use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    time::Duration,
};

const MAX_TRACKED: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    seconds: u64,
    micros: u64,
}

impl Identity {
    fn from(info: &libc::proc_bsdinfo) -> Self {
        Self {
            seconds: info.pbi_start_tvsec,
            micros: info.pbi_start_tvusec,
        }
    }
}

fn inspect(pid: i32) -> io::Result<Option<libc::proc_bsdinfo>> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read == size {
        Ok(Some(unsafe { info.assume_init() }))
    } else {
        let error = io::Error::last_os_error();
        if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(io::Error::other(format!(
                "cannot inspect process {pid}: {error}"
            )))
        }
    }
}

fn children(pid: i32) -> io::Result<Vec<i32>> {
    let mut result = vec![0i32; 64];
    loop {
        let count = unsafe {
            *libc::__error() = 0;
            libc::proc_listchildpids(
                pid,
                result.as_mut_ptr().cast(),
                std::mem::size_of_val(result.as_slice()) as i32,
            )
        };
        let error = io::Error::last_os_error();
        if count < 0 || (count == 0 && !matches!(error.raw_os_error(), Some(0 | libc::ESRCH))) {
            return Err(error);
        }
        if (count as usize) < result.len() {
            result.truncate(count as usize);
            return Ok(result);
        }
        if result.len() >= MAX_TRACKED {
            return Err(io::Error::other("descendant tracking capacity exceeded"));
        }
        result.resize(result.len() * 2, 0);
    }
}

pub struct Descendants {
    known: HashMap<i32, Identity>,
}

impl Descendants {
    pub fn new(leader: i32) -> io::Result<Self> {
        let mut known = HashMap::new();
        if let Some(info) = inspect(leader)? {
            known.insert(leader, Identity::from(&info));
        }
        Ok(Self { known })
    }

    pub fn observe(&mut self) -> io::Result<()> {
        let mut pending: VecDeque<_> = self.known.keys().copied().collect();
        let mut visited = HashSet::new();
        while let Some(pid) = pending.pop_front() {
            if !visited.insert(pid) {
                continue;
            }
            let Some(info) = inspect(pid)? else {
                self.known.remove(&pid);
                continue;
            };
            if self.known.get(&pid) != Some(&Identity::from(&info)) {
                self.known.remove(&pid);
                continue;
            }
            let child_pids = children(pid)?;
            if inspect(pid)?.as_ref().map(Identity::from) != self.known.get(&pid).copied() {
                continue;
            }
            for child in child_pids {
                if let Some(info) = inspect(child)? {
                    if info.pbi_ppid != pid as u32 {
                        continue;
                    }
                    if self.known.len() >= MAX_TRACKED && !self.known.contains_key(&child) {
                        return Err(io::Error::other("descendant tracking capacity exceeded"));
                    }
                    self.known.insert(child, Identity::from(&info));
                    pending.push_back(child);
                }
            }
        }
        Ok(())
    }

    fn signal(&self) -> io::Result<()> {
        for (&pid, identity) in &self.known {
            if let Some(info) = inspect(pid)?
                && Identity::from(&info) == *identity
                && unsafe { libc::kill(pid, libc::SIGKILL) } < 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub async fn finish(&mut self) -> io::Result<()> {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                self.observe()?;
                if self.known.is_empty() {
                    return Ok(());
                }
                self.signal()?;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| io::Error::other("observed descendants did not exit"))?
    }
}

impl Drop for Descendants {
    fn drop(&mut self) {
        let _ = self.signal();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn changed_identity_is_never_signalled() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("10")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let mut descendants = Descendants::new(pid).unwrap();
        descendants.known.get_mut(&pid).unwrap().seconds += 1;
        descendants.signal().unwrap();
        descendants.finish().await.unwrap();
        let survived = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(survived);
    }
}
