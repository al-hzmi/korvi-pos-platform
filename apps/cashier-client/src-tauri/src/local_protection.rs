use tauri::{AppHandle, Runtime};

#[cfg(windows)]
mod platform {
    use base64::{engine::general_purpose, Engine as _};
    use std::{ffi::c_void, ptr};
    use tauri::{AppHandle, Runtime};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            optional_entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    fn decode(value: &str, label: &str) -> Result<Vec<u8>, String> {
        general_purpose::STANDARD
            .decode(value)
            .map_err(|_| format!("{label} must be canonical Base64"))
    }

    fn blob(bytes: &mut [u8]) -> DataBlob {
        DataBlob {
            cb_data: bytes.len() as u32,
            pb_data: bytes.as_mut_ptr(),
        }
    }

    fn run(protect: bool, input: &str, aad: &str) -> Result<String, String> {
        let mut input_bytes = decode(input, "local-store payload")?;
        let mut entropy_bytes = decode(aad, "local-store AAD")?;
        if input_bytes.is_empty() || entropy_bytes.is_empty() {
            return Err("local-store payload and AAD must not be empty".into());
        }
        let input_blob = blob(&mut input_bytes);
        let entropy_blob = blob(&mut entropy_bytes);
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input_blob,
                    ptr::null(),
                    &entropy_blob,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input_blob,
                    ptr::null_mut(),
                    &entropy_blob,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 || output.pb_data.is_null() || output.cb_data == 0 {
            return Err(if protect {
                "Windows DPAPI local-store protection failed".into()
            } else {
                "Windows DPAPI refused local-store ciphertext or binding metadata".into()
            });
        }
        let bytes = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) };
        let encoded = general_purpose::STANDARD.encode(bytes);
        unsafe {
            let _ = LocalFree(output.pb_data.cast::<c_void>());
        }
        Ok(encoded)
    }

    pub fn protect<R: Runtime>(
        _app: &AppHandle<R>,
        plaintext_base64: &str,
        aad_base64: &str,
    ) -> Result<String, String> {
        run(true, plaintext_base64, aad_base64)
    }

    pub fn unprotect<R: Runtime>(
        _app: &AppHandle<R>,
        protected_base64: &str,
        aad_base64: &str,
    ) -> Result<String, String> {
        run(false, protected_base64, aad_base64)
    }
}

#[cfg(target_os = "android")]
mod platform {
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_korvi_device_identity::DeviceIdentityExt;

    pub fn protect<R: Runtime>(
        app: &AppHandle<R>,
        plaintext_base64: &str,
        aad_base64: &str,
    ) -> Result<String, String> {
        app.device_identity()
            .protect(plaintext_base64.to_owned(), aad_base64.to_owned())
            .map_err(|error| error.to_string())
    }

    pub fn unprotect<R: Runtime>(
        app: &AppHandle<R>,
        protected_base64: &str,
        aad_base64: &str,
    ) -> Result<String, String> {
        app.device_identity()
            .unprotect(protected_base64.to_owned(), aad_base64.to_owned())
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(any(windows, target_os = "android")))]
mod platform {
    use tauri::{AppHandle, Runtime};
    pub fn protect<R: Runtime>(
        _app: &AppHandle<R>,
        _plaintext_base64: &str,
        _aad_base64: &str,
    ) -> Result<String, String> {
        Err("Korvi local-store protection is supported only on Windows and Android".into())
    }
    pub fn unprotect<R: Runtime>(
        _app: &AppHandle<R>,
        _protected_base64: &str,
        _aad_base64: &str,
    ) -> Result<String, String> {
        Err("Korvi local-store protection is supported only on Windows and Android".into())
    }
}

pub fn protect<R: Runtime>(
    app: &AppHandle<R>,
    plaintext_base64: &str,
    aad_base64: &str,
) -> Result<String, String> {
    platform::protect(app, plaintext_base64, aad_base64)
}

pub fn unprotect<R: Runtime>(
    app: &AppHandle<R>,
    protected_base64: &str,
    aad_base64: &str,
) -> Result<String, String> {
    platform::unprotect(app, protected_base64, aad_base64)
}
