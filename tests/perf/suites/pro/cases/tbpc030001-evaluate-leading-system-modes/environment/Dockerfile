# Python 二进制与 NumPy 文件受原始评分器哈希约束。
FROM almalinux:9.6@sha256:1d06c00a6025b4faf042d3827d9ea8dc6b7a75278cacc1c1399dcc7a89c07a01
ENV LANG=C.UTF-8
# 使用官方源避免随机镜像差异；EPEL 提供派生 runner 所需的工具。
RUN sed -i 's/^mirrorlist=/#mirrorlist=/; s/^# baseurl=/baseurl=/' /etc/yum.repos.d/almalinux*.repo \
    && dnf install -y python3-3.9.25-7.el9_8.2 python3-libs-3.9.25-7.el9_8.2 \
        python3-pip python3.11 gcc gcc-c++ git nodejs npm epel-release \
    && dnf clean all
WORKDIR /app
COPY resources/ /app/
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip download --index-url https://pypi.org/simple --only-binary=:all: --require-hashes -r /tmp/requirements.txt -d /app/vendor \
    && python3 -m pip install --no-index --find-links /app/vendor --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt
COPY verify_runtime.py /tmp/verify_runtime.py
RUN python3 /tmp/verify_runtime.py && rm /tmp/verify_runtime.py \
    && mkdir -p /logs/agent && chmod 0777 /logs /logs/agent
CMD ["sh", "-lc", "sleep infinity"]
