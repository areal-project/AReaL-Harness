//! Nonblocking PTY master; the slave becomes the child's controlling terminal.
use std::{
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, unix::AsyncFd};

#[derive(Clone)]
pub struct Master(Arc<AsyncFd<File>>);

pub fn open() -> io::Result<(Master, File)> {
    let (mut master, mut slave) = (-1, -1);
    let mut size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // openpty 的窗口参数在 macOS 为可变指针、Linux 为只读指针，显式裸指针兼容两者。
    // SAFETY: openpty initializes both owned descriptors on success.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &raw mut size,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    for file in [&master, &slave] {
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((Master(Arc::new(AsyncFd::new(master)?)), slave))
}

impl Master {
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: 描述符由 Arc 持有，winsize 在 ioctl 返回前有效。
        if unsafe { libc::ioctl(self.0.get_ref().as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn eof_character(&self) -> io::Result<u8> {
        let mut settings = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: tcgetattr 成功后完整初始化 termios。
        if unsafe { libc::tcgetattr(self.0.get_ref().as_raw_fd(), settings.as_mut_ptr()) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let settings = unsafe { settings.assume_init() };
        if settings.c_lflag & libc::ICANON == 0 || settings.c_cc[libc::VEOF] == 0 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "PTY EOF requires canonical mode and an enabled VEOF",
            ));
        }
        Ok(settings.c_cc[libc::VEOF])
    }
}

impl AsyncRead for Master {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut ready = std::task::ready!(self.0.poll_read_ready(cx))?;
            let result = ready.try_io(|fd| {
                use io::Read;
                let mut file = fd.get_ref();
                match file.read(buf.initialize_unfilled()) {
                    // Linux returns EIO when the last slave is closed.
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
                    result => result,
                }
            });
            match result {
                Ok(Ok(count)) => {
                    buf.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}
impl AsyncWrite for Master {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = std::task::ready!(self.0.poll_write_ready(cx))?;
            match ready.try_io(|fd| {
                use io::Write;
                let mut file = fd.get_ref();
                file.write(bytes)
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
