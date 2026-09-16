use std::{
    io::Write,
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

const ESC_POS_PORT: u16 = 9100;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PRINT_JOB_BYTES: usize = 1024 * 1024;

/// Send one already-rendered ESC/POS job to a LAN printer.
///
/// Rendering stays in `@korvi/printing`; this module owns only native delivery.
/// The port is intentionally fixed to the standard raw-print port and resolved
/// destinations are restricted to loopback/private/link-local networks. A
/// compromised WebView must not turn the native bridge into an arbitrary TCP
/// exfiltration primitive.
pub fn send_tcp_escpos(host: &str, payload: &[u8]) -> Result<(), String> {
    send_tcp_escpos_to(host, ESC_POS_PORT, payload, CONNECT_TIMEOUT)
}

fn send_tcp_escpos_to(
    host: &str,
    port: u16,
    payload: &[u8],
    timeout: Duration,
) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() || host.len() > 253 {
        return Err("printer host is invalid".into());
    }
    if payload.is_empty() {
        return Err("printer payload is empty".into());
    }
    if payload.len() > MAX_PRINT_JOB_BYTES {
        return Err("printer payload exceeds the 1 MiB safety limit".into());
    }

    let resolved = (host, port)
        .to_socket_addrs()
        .map_err(|_| "printer host could not be resolved".to_string())?;
    let addresses: Vec<SocketAddr> = resolved.filter(|address| local_address(address.ip())).collect();
    if addresses.is_empty() {
        return Err("printer host did not resolve to an allowed local-network address".into());
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(mut stream) => {
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|_| "printer write timeout could not be configured".to_string())?;
                stream
                    .write_all(payload)
                    .map_err(|_| "printer connection failed while sending the job".to_string())?;
                stream
                    .flush()
                    .map_err(|_| "printer connection failed while flushing the job".to_string())?;
                return Ok(());
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(match last_error {
        Some(_) => "printer could not be reached on the local network".into(),
        None => "printer has no usable local-network address".into(),
    })
}

fn local_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        IpAddr::V6(address) => {
            let first = address.segments()[0];
            address.is_loopback()
                || first & 0xfe00 == 0xfc00 // fc00::/7 unique-local
                || first & 0xffc0 == 0xfe80 // fe80::/10 link-local
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        net::{Ipv4Addr, Ipv6Addr, TcpListener},
        thread,
    };

    #[test]
    fn address_policy_allows_only_local_networks() {
        assert!(local_address(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(local_address(IpAddr::V4(Ipv4Addr::new(10, 2, 3, 4))));
        assert!(local_address(IpAddr::V4(Ipv4Addr::new(172, 16, 1, 9))));
        assert!(local_address(IpAddr::V4(Ipv4Addr::new(192, 168, 5, 7))));
        assert!(local_address(IpAddr::V4(Ipv4Addr::new(169, 254, 10, 20))));
        assert!(local_address(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(local_address(IpAddr::V6("fd00::1".parse().expect("fixture"))));
        assert!(local_address(IpAddr::V6("fe80::1".parse().expect("fixture"))));

        assert!(!local_address(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!local_address(IpAddr::V6("2001:4860:4860::8888".parse().expect("fixture"))));
    }

    #[test]
    fn rejects_empty_and_public_jobs_before_connecting() {
        assert_eq!(
            send_tcp_escpos_to("127.0.0.1", 9100, &[], Duration::from_millis(50)),
            Err("printer payload is empty".into())
        );
        assert_eq!(
            send_tcp_escpos_to("8.8.8.8", 9100, b"x", Duration::from_millis(50)),
            Err("printer host did not resolve to an allowed local-network address".into())
        );
    }

    #[test]
    fn sends_the_exact_rendered_bytes_to_a_local_printer_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
        let address = listener.local_addr().expect("fixture address");
        let expected = b"\x1b@KORVI\n\x1dV\x00".to_vec();
        let reader = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept fixture print job");
            let mut received = Vec::new();
            socket.read_to_end(&mut received).expect("read fixture print job");
            received
        });

        send_tcp_escpos_to(
            "127.0.0.1",
            address.port(),
            &expected,
            Duration::from_secs(1),
        )
        .expect("send fixture print job");

        assert_eq!(reader.join().expect("join fixture printer"), expected);
    }
}