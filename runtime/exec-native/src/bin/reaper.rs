#[cfg(target_os = "linux")]
#[path = "../reaper_helper.rs"]
mod helper;

fn main() {
    #[cfg(target_os = "linux")]
    std::process::exit(helper::run());
    #[cfg(not(target_os = "linux"))]
    std::process::exit(1);
}
