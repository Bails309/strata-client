# Minimal OpenSSH target for the strata-session live SSH tests.
#
# Deliberately password-authenticated with a well-known credential: this
# image exists only to be connected to from a test on an isolated Docker
# network, and must never be published or run anywhere reachable.
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && ssh-keygen -A \
    && useradd -m -s /bin/bash strata \
    && echo 'strata:strata-test-password' | chpasswd

# A fixed prompt and no login noise, so assertions on terminal output are
# about the engine rather than about Debian's motd.
RUN printf 'PS1="strata$ "\n' >> /home/strata/.bashrc \
    && touch /home/strata/.hushlogin \
    && chown strata:strata /home/strata/.hushlogin

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
