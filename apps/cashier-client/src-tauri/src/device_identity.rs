use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityInfo {
    pub platform: String,
    pub installation_id: String,
    pub key_algorithm: String,
    pub public_key_spki: String,
    pub public_key_sha256: String,
    pub custody: String,
    pub hardware_backed: bool,
    pub strongbox_backed: bool,
}

#[cfg(windows)]
mod platform {
    use super::DeviceIdentityInfo;
    use base64::{engine::general_purpose, Engine as _};
    use sha2::{Digest, Sha256};
    use std::{ffi::c_void, ptr};
    use tauri::{AppHandle, Runtime};

    type Handle = usize;
    type Status = i32;
    const SUCCESS: Status = 0;
    const KEY_NAME: &str = "Korvi Cashier Device Identity v1";
    const PLATFORM_PROVIDER: &str = "Microsoft Platform Crypto Provider";
    const SOFTWARE_PROVIDER: &str = "Microsoft Software Key Storage Provider";
    const ECDSA_P256: &str = "ECDSA_P256";
    const ECC_PUBLIC_BLOB: &str = "ECCPUBLICBLOB";

    #[link(name = "ncrypt")]
    extern "system" {
        fn NCryptOpenStorageProvider(provider: *mut Handle, name: *const u16, flags: u32)
            -> Status;
        fn NCryptOpenKey(
            provider: Handle,
            key: *mut Handle,
            name: *const u16,
            legacy: u32,
            flags: u32,
        ) -> Status;
        fn NCryptCreatePersistedKey(
            provider: Handle,
            key: *mut Handle,
            algorithm: *const u16,
            name: *const u16,
            legacy: u32,
            flags: u32,
        ) -> Status;
        fn NCryptFinalizeKey(key: Handle, flags: u32) -> Status;
        fn NCryptExportKey(
            key: Handle,
            export_key: Handle,
            blob_type: *const u16,
            params: *mut c_void,
            output: *mut u8,
            output_len: u32,
            result: *mut u32,
            flags: u32,
        ) -> Status;
        fn NCryptSignHash(
            key: Handle,
            padding: *mut c_void,
            hash: *const u8,
            hash_len: u32,
            signature: *mut u8,
            signature_len: u32,
            result: *mut u32,
            flags: u32,
        ) -> Status;
        fn NCryptFreeObject(object: Handle) -> Status;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct CngKey {
        provider: Handle,
        key: Handle,
        hardware: bool,
    }
    impl Drop for CngKey {
        fn drop(&mut self) {
            unsafe {
                let _ = NCryptFreeObject(self.key);
                let _ = NCryptFreeObject(self.provider);
            }
        }
    }

    fn open_provider(name: &str) -> Result<Handle, Status> {
        let mut provider = 0usize;
        let status = unsafe { NCryptOpenStorageProvider(&mut provider, wide(name).as_ptr(), 0) };
        if status == SUCCESS {
            Ok(provider)
        } else {
            Err(status)
        }
    }

    fn open_existing(provider: Handle) -> Result<Handle, Status> {
        let mut key = 0usize;
        let status = unsafe { NCryptOpenKey(provider, &mut key, wide(KEY_NAME).as_ptr(), 0, 0) };
        if status == SUCCESS {
            Ok(key)
        } else {
            Err(status)
        }
    }

    fn open_or_create() -> Result<CngKey, String> {
        for (provider_name, hardware) in [(PLATFORM_PROVIDER, true), (SOFTWARE_PROVIDER, false)] {
            if let Ok(provider) = open_provider(provider_name) {
                if let Ok(key) = open_existing(provider) {
                    return Ok(CngKey {
                        provider,
                        key,
                        hardware,
                    });
                }
                unsafe {
                    let _ = NCryptFreeObject(provider);
                }
            }
        }
        for (provider_name, hardware) in [(PLATFORM_PROVIDER, true), (SOFTWARE_PROVIDER, false)] {
            let provider = match open_provider(provider_name) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mut key = 0usize;
            let created = unsafe {
                NCryptCreatePersistedKey(
                    provider,
                    &mut key,
                    wide(ECDSA_P256).as_ptr(),
                    wide(KEY_NAME).as_ptr(),
                    0,
                    0,
                )
            };
            if created == SUCCESS && unsafe { NCryptFinalizeKey(key, 0) } == SUCCESS {
                return Ok(CngKey {
                    provider,
                    key,
                    hardware,
                });
            }
            if key != 0 {
                unsafe {
                    let _ = NCryptFreeObject(key);
                }
            }
            unsafe {
                let _ = NCryptFreeObject(provider);
            }
        }
        Err("Windows CNG could not create or open the Korvi device key".into())
    }

    fn public_spki(key: Handle) -> Result<Vec<u8>, String> {
        let blob = wide(ECC_PUBLIC_BLOB);
        let mut needed = 0u32;
        let status = unsafe {
            NCryptExportKey(
                key,
                0,
                blob.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut needed,
                0,
            )
        };
        if status != SUCCESS || needed < 72 {
            return Err("Windows CNG public-key export failed".into());
        }
        let mut output = vec![0u8; needed as usize];
        let status = unsafe {
            NCryptExportKey(
                key,
                0,
                blob.as_ptr(),
                ptr::null_mut(),
                output.as_mut_ptr(),
                needed,
                &mut needed,
                0,
            )
        };
        if status != SUCCESS {
            return Err("Windows CNG public-key export failed".into());
        }
        output.truncate(needed as usize);
        let key_len = u32::from_le_bytes(
            output[4..8]
                .try_into()
                .map_err(|_| "invalid CNG public key")?,
        ) as usize;
        if key_len != 32 || output.len() < 8 + key_len * 2 {
            return Err("Windows CNG returned an unexpected P-256 public key".into());
        }
        const PREFIX: &[u8] = &[
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
            0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
        ];
        let mut spki = Vec::with_capacity(PREFIX.len() + 64);
        spki.extend_from_slice(PREFIX);
        spki.extend_from_slice(&output[8..8 + 64]);
        Ok(spki)
    }

    fn installation_id(hash: &[u8]) -> String {
        let mut b = [0u8; 16];
        b.copy_from_slice(&hash[..16]);
        b[6] = (b[6] & 0x0f) | 0x50;
        b[8] = (b[8] & 0x3f) | 0x80;
        format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15])
    }

    fn der_integer(raw: &[u8]) -> Vec<u8> {
        let first = raw.iter().position(|b| *b != 0).unwrap_or(raw.len() - 1);
        let body = &raw[first..];
        let pad = body[0] & 0x80 != 0;
        let mut out = Vec::with_capacity(body.len() + 3);
        out.push(0x02);
        out.push((body.len() + usize::from(pad)) as u8);
        if pad {
            out.push(0);
        }
        out.extend_from_slice(body);
        out
    }

    fn p1363_to_der(raw: &[u8]) -> Result<Vec<u8>, String> {
        if raw.len() != 64 {
            return Err("Windows CNG returned an unexpected ECDSA signature".into());
        }
        let r = der_integer(&raw[..32]);
        let s = der_integer(&raw[32..]);
        let mut out = Vec::with_capacity(2 + r.len() + s.len());
        out.push(0x30);
        out.push((r.len() + s.len()) as u8);
        out.extend_from_slice(&r);
        out.extend_from_slice(&s);
        Ok(out)
    }

    pub fn identity<R: Runtime>(_app: &AppHandle<R>) -> Result<DeviceIdentityInfo, String> {
        let key = open_or_create()?;
        let spki = public_spki(key.key)?;
        let hash = Sha256::digest(&spki);
        Ok(DeviceIdentityInfo {
            platform: "windows".into(),
            installation_id: installation_id(&hash),
            key_algorithm: "p256".into(),
            public_key_spki: general_purpose::STANDARD.encode(&spki),
            public_key_sha256: format!("{hash:x}"),
            custody: if key.hardware {
                "windows-cng-tpm".into()
            } else {
                "windows-cng-software".into()
            },
            hardware_backed: key.hardware,
            strongbox_backed: false,
        })
    }

    pub fn sign<R: Runtime>(_app: &AppHandle<R>, payload: &str) -> Result<String, String> {
        let key = open_or_create()?;
        let hash = Sha256::digest(payload.as_bytes());
        let mut needed = 0u32;
        let status = unsafe {
            NCryptSignHash(
                key.key,
                ptr::null_mut(),
                hash.as_ptr(),
                hash.len() as u32,
                ptr::null_mut(),
                0,
                &mut needed,
                0,
            )
        };
        if status != SUCCESS {
            return Err("Windows CNG signing failed".into());
        }
        let mut raw = vec![0u8; needed as usize];
        let status = unsafe {
            NCryptSignHash(
                key.key,
                ptr::null_mut(),
                hash.as_ptr(),
                hash.len() as u32,
                raw.as_mut_ptr(),
                needed,
                &mut needed,
                0,
            )
        };
        if status != SUCCESS {
            return Err("Windows CNG signing failed".into());
        }
        raw.truncate(needed as usize);
        Ok(general_purpose::URL_SAFE_NO_PAD.encode(p1363_to_der(&raw)?))
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::DeviceIdentityInfo;
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_korvi_device_identity::DeviceIdentityExt;

    pub fn identity<R: Runtime>(app: &AppHandle<R>) -> Result<DeviceIdentityInfo, String> {
        let value = app
            .device_identity()
            .identity()
            .map_err(|e| e.to_string())?;
        Ok(DeviceIdentityInfo {
            platform: "android".into(),
            installation_id: value.installation_id,
            key_algorithm: value.key_algorithm,
            public_key_spki: value.public_key_spki,
            public_key_sha256: value.public_key_sha256,
            custody: value.custody,
            hardware_backed: value.hardware_backed,
            strongbox_backed: value.strongbox_backed,
        })
    }
    pub fn sign<R: Runtime>(app: &AppHandle<R>, payload: &str) -> Result<String, String> {
        app.device_identity()
            .sign(payload.to_owned())
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(any(windows, target_os = "android")))]
mod platform {
    use super::DeviceIdentityInfo;
    use tauri::{AppHandle, Runtime};
    pub fn identity<R: Runtime>(_app: &AppHandle<R>) -> Result<DeviceIdentityInfo, String> {
        Err("Korvi installed device identity is supported only on Windows and Android".into())
    }
    pub fn sign<R: Runtime>(_app: &AppHandle<R>, _payload: &str) -> Result<String, String> {
        Err("Korvi installed device identity is supported only on Windows and Android".into())
    }
}

pub fn identity<R: Runtime>(app: &AppHandle<R>) -> Result<DeviceIdentityInfo, String> {
    platform::identity(app)
}
pub fn sign<R: Runtime>(app: &AppHandle<R>, payload: &str) -> Result<String, String> {
    platform::sign(app, payload)
}
