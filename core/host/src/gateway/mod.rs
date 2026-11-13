//! Gateway 的身份认证和线格式。身份存储与会话授权由 Host 所有者负责。
pub(crate) mod direct;
pub(crate) mod relay;
pub(crate) mod relay_codec;
pub(crate) mod wire;
