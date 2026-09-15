#![cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "com.korvi.cashier.identity";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub installation_id: String,
    pub key_algorithm: String,
    pub public_key_spki: String,
    pub public_key_sha256: String,
    pub custody: String,
    pub hardware_backed: bool,
    pub strongbox_backed: bool,
}
#[derive(Serialize)]
struct SignRequest {
    payload: String,
}
#[derive(Deserialize)]
struct SignResponse {
    signature: String,
}

pub struct DeviceIdentity<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> DeviceIdentity<R> {
    pub fn identity(&self) -> Result<IdentityInfo> {
        Ok(self.0.run_mobile_plugin("identity", ())?)
    }
    pub fn sign(&self, payload: String) -> Result<String> {
        let value: SignResponse = self.0.run_mobile_plugin("sign", SignRequest { payload })?;
        Ok(value.signature)
    }
}
pub trait DeviceIdentityExt<R: Runtime> {
    fn device_identity(&self) -> &DeviceIdentity<R>;
}
impl<R: Runtime, T: Manager<R>> DeviceIdentityExt<R> for T {
    fn device_identity(&self) -> &DeviceIdentity<R> {
        self.state::<DeviceIdentity<R>>().inner()
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("korvi-device-identity")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "DeviceIdentityPlugin")?;
            app.manage(DeviceIdentity(handle));
            Ok(())
        })
        .build()
}
