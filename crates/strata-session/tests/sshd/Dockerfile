# Minimal OpenSSH target for the strata-session live SSH tests.
#
# Deliberately password-authenticated with a well-known credential: this
# image exists only to be connected to from a test on an isolated Docker
# network, and must never be published or run anywhere reachable.
FROM debian:trixie-slim@sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b

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

# A symlink inside the SFTP tests' root (/tmp) pointing at a writable file
# outside it: an upload to the link must not reach the target.
RUN echo original > /home/strata/outside.txt \
    && chown strata:strata /home/strata/outside.txt \
    && ln -s /home/strata/outside.txt /tmp/strata-link.txt

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
