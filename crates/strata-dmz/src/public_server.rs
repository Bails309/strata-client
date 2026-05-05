//! Public listener — terminates TLS (or plaintext in dev mode) and
//! drives the public router via hyper-util's `auto::Builder` so both
//! HTTP/1.1 and HTTP/2 clients work.
//!
//! `axum::serve` doesn't expose a TLS termination seam, so the public
//! listener gets its own bespoke driver. The link and operator
//! listeners keep using `axum::serve` because they don't need TLS
//! (link is mTLS handled separately, operator is plaintext on the
//! management interface by design).

use std::net::SocketAddr;

use anyhow::Context;
use axum::body::Body;
use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoBuilder;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;
use tower::Service;

/// Drive the public listener until `shutdown` cancels.
///
/// When `tls` is `Some(_)`, every accepted TCP connection is wrapped
/// in a TLS handshake before being driven. When `tls` is `None`
/// (dev mode), connections are plaintext.
pub async fn serve_public(
    bind: SocketAddr,
    router: Router,
    tls: Option<TlsAcceptor>,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(bind)
        .await
        .with_context(|| format!("bind public listener on {bind}"))?;
    let scheme = if tls.is_some() { "https" } else { "http" };
    tracing::info!(addr = %bind, %scheme, "DMZ public listener up");

    // Build a make-service that injects ConnectInfo<SocketAddr> per
    // connection. We mint a fresh per-connection axum service for
    // every accept so handlers (and the proxy's edge-header signer)
    // see the socket peer.
    let mut make_router = router.into_make_service_with_connect_info::<SocketAddr>();

    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                tracing::info!("DMZ public listener shutting down");
                break;
            }
            accept = listener.accept() => {
                let (tcp, peer) = match accept {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "DMZ public accept failed");
                        continue;
                    }
                };
                if let Err(e) = tcp.set_nodelay(true) {
                    tracing::warn!(%peer, error = %e, "set_nodelay failed on public socket");
                }

                // Mint the per-connection service while we still own
                // `make_router`. axum's IntoMakeService future is
                // `Infallible`, so a Result error is unreachable.
                let service: Router = match make_router.call(peer).await {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let svc = HyperRouterService { router: service };

                let tls = tls.clone();
                let shutdown = shutdown.clone();

                tokio::spawn(async move {
                    let builder = AutoBuilder::new(TokioExecutor::new());

                    if let Some(acceptor) = tls {
                        let stream = match acceptor.accept(tcp).await {
                            Ok(s) => s,
                            Err(e) => {
                                tracing::debug!(%peer, error = %e, "public TLS handshake failed");
                                return;
                            }
                        };
                        drive(builder, TokioIo::new(stream), svc, peer, shutdown).await;
                    } else {
                        drive(builder, TokioIo::new(tcp), svc, peer, shutdown).await;
                    }
                });
            }
        }
    }
    Ok(())
}

async fn drive<I>(
    builder: AutoBuilder<TokioExecutor>,
    io: I,
    svc: HyperRouterService,
    peer: SocketAddr,
    shutdown: CancellationToken,
) where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let conn = builder.serve_connection_with_upgrades(io, svc);
    tokio::pin!(conn);
    tokio::select! {
        _ = shutdown.cancelled() => {
            conn.as_mut().graceful_shutdown();
        }
        res = conn.as_mut() => {
            if let Err(e) = res {
                tracing::debug!(%peer, error = %e, "public connection terminated");
            }
        }
    }
}

/// Adapter that converts a hyper `Request<Incoming>` into the axum
/// `Request<Body>` that `Router` expects, and bridges hyper's
/// `&self`-flavoured `Service` trait to tower's `&mut self` one.
///
/// `Router` is `Clone` and always-ready (`poll_ready` returns
/// `Ready(Ok(()))`), so we can clone it per request and dispatch
/// without external synchronisation — this keeps multiple H2 streams
/// on the same connection genuinely concurrent.
#[derive(Clone)]
struct HyperRouterService {
    router: Router,
}

impl hyper::service::Service<http::Request<hyper::body::Incoming>> for HyperRouterService {
    type Response = http::Response<Body>;
    type Error = std::convert::Infallible;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;

    fn call(&self, req: http::Request<hyper::body::Incoming>) -> Self::Future {
        let mut router = self.router.clone();
        Box::pin(async move {
            let (parts, body) = req.into_parts();
            let req = http::Request::from_parts(parts, Body::new(body));
            <Router as Service<http::Request<Body>>>::call(&mut router, req).await
        })
    }
}
