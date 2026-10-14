# 使用 Node.js 22 (Alpine，musl libc，体积约为 Debian 版的 1/4)
FROM node:22-alpine

# 安装基础工具
# - coreutils: busybox 的 timeout/sleep 语义与 GNU 有差异，
#   docker.ts 依赖 `timeout -s KILL <N>s` 和 ENTRYPOINT 的 `sleep infinity`
# - shadow: Alpine 没有 usermod/groupmod（默认只有 adduser/addgroup）
RUN apk add --no-cache \
  git \
  curl \
  jq \
  coreutils \
  shadow

# 安装 GitHub CLI（Alpine community 仓库）
RUN apk add --no-cache github-cli

# 安装 Claude Code CLI（通过 npm 以绕过 claude.ai 的地区限制）
RUN npm install -g @anthropic-ai/claude-code

# 安装 Pi coding agent CLI（默认 AGENT=pi）
RUN npm install -g @earendil-works/pi-coding-agent

# 对齐 UID/GID（避免权限问题）
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

ENV PATH="/home/agent/.local/bin:/usr/local/bin:$PATH"

WORKDIR /home/agent

# 关键：sleep infinity 保持容器运行（GNU coreutils 支持 infinity）
# sandcastle 通过 docker exec 向容器发送命令
ENTRYPOINT ["sleep", "infinity"]