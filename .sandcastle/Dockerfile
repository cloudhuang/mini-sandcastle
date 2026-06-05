# 使用 Node.js 22 (Debian Bookworm)
FROM node:22-bookworm

# 安装基础工具
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# 安装 GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# 安装 Claude Code CLI（通过 npm 以绕过 claude.ai 的地区限制）
RUN npm install -g @anthropic-ai/claude-code

# 对齐 UID/GID（避免权限问题）
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

ENV PATH="/home/agent/.local/bin:/usr/local/bin:$PATH"

WORKDIR /home/agent

# 关键：sleep infinity 保持容器运行
# sandcastle 通过 docker exec 向容器发送命令
ENTRYPOINT ["sleep", "infinity"]