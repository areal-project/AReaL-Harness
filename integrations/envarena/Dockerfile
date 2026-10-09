FROM alpine:3.23.4

RUN apk add --no-cache bash build-base cmake git python3 curl perl \
    bubblewrap=0.12.0-r0 libcap2=2.78-r0 musl=1.2.5-r23
RUN curl -fsSL https://static.rust-lang.org/dist/rust-1.94.0-x86_64-unknown-linux-musl.tar.xz -o /tmp/rust.tar.xz \
    && echo '9a358120ce1491a4d5b7f71a41e4e97b380b5db5d4ec31f7110f5b3090bd3d55  /tmp/rust.tar.xz' | sha256sum -c - \
    && python3 -c 'import tarfile; tarfile.open("/tmp/rust.tar.xz").extractall("/tmp", filter="data")' \
    && /tmp/rust-1.94.0-x86_64-unknown-linux-musl/install.sh --prefix=/opt/rust --components=rustc,cargo,rust-std-x86_64-unknown-linux-musl --disable-ldconfig \
    && rm -rf /tmp/rust.tar.xz /tmp/rust-1.94.0-x86_64-unknown-linux-musl
ENV PATH="/opt/rust/bin:${PATH}"
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY runtime ./runtime
COPY clients ./clients
COPY scripts/install.py ./scripts/install.py
RUN rustc --version && cargo build --locked --release \
    -p areal-cli -p areal-runtime -p areal-runtime-fs -p areal-runtime-exec-native
RUN mkdir -p /out/bin /out/utilities/bin/tools /out/utilities/lib \
    /out/utilities/licenses/bubblewrap /out/utilities/licenses/libcap /out/utilities/licenses/musl \
    && cp target/release/areal target/release/areal-runtime target/release/areal-runtime-fs target/release/areal-runtime-reaper /out/bin/ \
    && cp /usr/bin/bwrap /out/utilities/bin/ \
    && cp -L /lib/ld-musl-x86_64.so.1 /usr/lib/libcap.so.2 /out/utilities/lib/
RUN curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz -o /tmp/rg.tar.gz \
    && echo '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c  /tmp/rg.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/rg.tar.gz -C /tmp \
    && cp /tmp/ripgrep-15.2.0-x86_64-unknown-linux-musl/rg /out/utilities/bin/tools/ \
    && mkdir -p /out/utilities/licenses/ripgrep \
    && cp /tmp/ripgrep-15.2.0-x86_64-unknown-linux-musl/COPYING /tmp/ripgrep-15.2.0-x86_64-unknown-linux-musl/LICENSE-MIT /tmp/ripgrep-15.2.0-x86_64-unknown-linux-musl/UNLICENSE /out/utilities/licenses/ripgrep/ \
    && curl -fsSL https://raw.githubusercontent.com/containers/bubblewrap/v0.12.0/COPYING -o /out/utilities/licenses/bubblewrap/COPYING \
    && curl -fsSL 'https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5' -o /out/utilities/licenses/musl/COPYRIGHT \
    && curl -fsSL https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.78.tar.xz -o /tmp/libcap.tar.xz \
    && python3 -c 'import tarfile,pathlib; t=tarfile.open("/tmp/libcap.tar.xz"); [(pathlib.Path("/out/utilities/licenses/libcap")/n.replace("/","_")).write_bytes(t.extractfile("libcap-2.78/"+n).read()) for n in ("License", "libcap/License")]'
ENTRYPOINT []
