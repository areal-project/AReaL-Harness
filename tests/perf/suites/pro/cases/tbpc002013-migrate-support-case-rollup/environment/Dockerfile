# 评分器校验系统运行库；固定软件包版本并核对全部运行时文件。
FROM gcc:13.4.0-bookworm@sha256:ed4c7f6a03f119d013ed8fc58524549365e3be74d6388c401035401cb2ef04ef
ENV LANG=C.UTF-8
COPY packages.txt /tmp/packages.txt
RUN apt-get update \
    && xargs apt-get install -y --no-install-recommends --allow-downgrades < /tmp/packages.txt \
    && rm -rf /var/lib/apt/lists/* /tmp/packages.txt
WORKDIR /app
COPY resources/ /app/
RUN mkdir -p /app/vendor /logs/agent \
    && cp /usr/lib/x86_64-linux-gnu/libpython3.11.so.1.0 /app/vendor/ \
    && chmod 0555 /app/public/run_legacy_*.sh \
    && chmod -R a-w /app/legacy /app/public \
    && chmod 0777 /logs /logs/agent
COPY runtime.sha256 /tmp/runtime.sha256
RUN sha256sum --quiet -c /tmp/runtime.sha256 && rm /tmp/runtime.sha256
CMD ["sh", "-lc", "sleep infinity"]
