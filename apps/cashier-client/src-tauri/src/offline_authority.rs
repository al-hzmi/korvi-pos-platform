use serde::{Deserialize, Serialize};

pub const CACHE_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineLeaseServerResponse {
    pub lease: String,
    pub verification_key_spki: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedOfflineAuthority {
    pub version: u8,
    pub lease: String,
    pub verification_key_spki: String,
    pub device_envelope: String,
    pub device_signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceEnvelope<'a> {
    version: u8,
    lease: &'a str,
    verification_key_spki: &'a str,
}

pub fn device_envelope(lease: &str, verification_key_spki: &str) -> Result<String, String> {
    if !lease.starts_with("kol1.") || lease.len() > 64 * 1024 {
        return Err("offline authority returned an invalid lease envelope".into());
    }
    if verification_key_spki.trim().is_empty() || verification_key_spki.len() > 1024 {
        return Err("offline authority returned invalid public verification material".into());
    }
    serde_json::to_string(&DeviceEnvelope {
        version: CACHE_VERSION,
        lease,
        verification_key_spki,
    })
    .map_err(|error| format!("cannot encode offline authority device envelope: {error}"))
}

pub fn cached(
    lease: String,
    verification_key_spki: String,
    device_signature: String,
) -> Result<CachedOfflineAuthority, String> {
    if device_signature.trim().is_empty() || device_signature.len() > 1024 {
        return Err("device refused to seal offline authority".into());
    }
    let device_envelope = device_envelope(&lease, &verification_key_spki)?;
    Ok(CachedOfflineAuthority {
        version: CACHE_VERSION,
        lease,
        verification_key_spki,
        device_envelope,
        device_signature,
    })
}

pub fn validate_cached(value: CachedOfflineAuthority) -> Result<CachedOfflineAuthority, String> {
    if value.version != CACHE_VERSION {
        return Err("offline authority cache version is unsupported".into());
    }
    if device_envelope(&value.lease, &value.verification_key_spki)? != value.device_envelope {
        return Err("offline authority cache envelope is corrupt".into());
    }
    if value.device_signature.trim().is_empty() || value.device_signature.len() > 1024 {
        return Err("offline authority cache signature is invalid".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_envelope_is_canonical_and_fail_closed() {
        let cached = cached(
            "kol1.payload.signature".into(),
            "MCowBQYDK2VwAyEAexample".into(),
            "device-signature".into(),
        )
        .expect("cache");
        assert_eq!(cached.version, 1);
        assert!(cached.device_envelope.contains("\"version\":1"));
        assert!(validate_cached(cached.clone()).is_ok());

        let mut tampered = cached;
        tampered.lease.push('x');
        assert!(validate_cached(tampered).is_err());
    }
}
