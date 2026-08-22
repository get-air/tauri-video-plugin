use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use gst::glib::translate::from_glib_full;
use gstreamer as gst;
use parking_lot::{Mutex, RwLock};

use windows::{
    core::{IUnknown, IUnknown_Vtbl, Interface, HRESULT, PCWSTR},
    Win32::{
        Foundation::HANDLE,
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11VideoDevice},
            Dxgi::IDXGIKeyedMutex,
        },
    },
};

use crate::{Error, Result};

const MAX_TEXTURES: u32 = 4;
const GST_MAP_D3D11: gst::ffi::GstMapFlags = gst::ffi::GST_MAP_FLAG_LAST << 1;

type UiJob = Box<dyn FnOnce() + Send + 'static>;
pub type UiDispatch = Arc<dyn Fn(UiJob) -> Result<()> + Send + Sync + 'static>;

pub struct TextureStreamPresenter {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    gst_device: SendGstDevice,
    gst_context: gst::Context,
    stream: SendStream,
    dispatch: UiDispatch,
    free: Arc<Mutex<Vec<DrawTarget>>>,
    texture_size: Arc<RwLock<Option<(u32, u32)>>>,
    pool_pending: Arc<AtomicBool>,
    reclaim_pending: Arc<AtomicBool>,
}

pub struct DrawTarget {
    texture: ICoreWebView2ExperimentalTexture,
    resource: ID3D11Resource,
}

struct D3d11MemoryMap {
    memory: *mut gst::ffi::GstMemory,
    info: gst::ffi::GstMapInfo,
}

impl D3d11MemoryMap {
    unsafe fn new(memory: *mut gst::ffi::GstMemory) -> Result<Self> {
        let mut info = unsafe { std::mem::zeroed() };
        // This map synchronizes a deferred upload and exposes the D3D resource;
        // it does not map decoded pixels into CPU-addressable memory.
        let flags = gst::ffi::GST_MAP_READ | GST_MAP_D3D11;
        if unsafe { gst::ffi::gst_memory_map(memory, &mut info, flags) } == gst::glib::ffi::GFALSE {
            return Err(Error::Pipeline(
                "could not map GStreamer D3D11 memory".into(),
            ));
        }
        Ok(Self { memory, info })
    }
}

impl Drop for D3d11MemoryMap {
    fn drop(&mut self) {
        unsafe { gst::ffi::gst_memory_unmap(self.memory, &mut self.info) };
    }
}

#[derive(Clone)]
struct SendStream(ICoreWebView2ExperimentalTextureStream);
struct SendGstDevice(*mut c_void);

// These COM references are transported back to the WebView UI thread before
// any methods are invoked. Shared-handle metadata is immutable between calls.
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}
unsafe impl Send for SendGstDevice {}
unsafe impl Sync for SendGstDevice {}
unsafe impl Send for DrawTarget {}
unsafe impl Sync for DrawTarget {}

impl Drop for SendGstDevice {
    fn drop(&mut self) {
        unsafe { gst::glib::gobject_ffi::g_object_unref(self.0.cast()) };
    }
}

impl SendStream {
    unsafe fn create_texture(
        &self,
        width: u32,
        height: u32,
    ) -> windows::core::Result<ICoreWebView2ExperimentalTexture> {
        unsafe { self.0.create_texture(width, height) }
    }

    unsafe fn present_texture(
        &self,
        texture: &ICoreWebView2ExperimentalTexture,
    ) -> windows::core::Result<()> {
        unsafe { self.0.present_texture(texture) }
    }
}

// NV12 resources are copied by GStreamer's serialized sample callback. All
// WebView2 COM method calls are dispatched back to its UI thread.
unsafe impl Send for TextureStreamPresenter {}
unsafe impl Sync for TextureStreamPresenter {}

impl TextureStreamPresenter {
    pub fn new<E: Interface>(
        environment: &E,
        stream_id: &str,
        dispatch: UiDispatch,
    ) -> Result<Self> {
        let environment: ICoreWebView2ExperimentalEnvironment12 = environment
            .cast()
            .map_err(texture_error("query WebView2 TextureStream support"))?;
        let adapter_luid = unsafe { environment.render_adapter_luid() }
            .map_err(texture_error("query the WebView2 render adapter"))?;
        let (device, context, gst_context, gst_device) =
            unsafe { gst_device_for_adapter(adapter_luid) }?;
        let device_unknown: IUnknown = device
            .cast()
            .map_err(texture_error("query the D3D11 device identity"))?;
        let stream_id = wide(stream_id);
        let stream = unsafe {
            environment.create_texture_stream(PCWSTR(stream_id.as_ptr()), &device_unknown)
        }
        .map_err(texture_error("create the WebView2 texture stream"))?;
        for origin in [
            "http://localhost:1420",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            let origin = wide(origin);
            let _ = unsafe { stream.add_allowed_origin(PCWSTR(origin.as_ptr()), false) };
        }
        Ok(Self {
            device,
            context,
            gst_device,
            gst_context,
            stream: SendStream(stream),
            dispatch,
            free: Arc::new(Mutex::new(Vec::with_capacity(MAX_TEXTURES as usize))),
            texture_size: Arc::new(RwLock::new(None)),
            pool_pending: Arc::new(AtomicBool::new(false)),
            reclaim_pending: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn gst_context(&self) -> gst::Context {
        self.gst_context.clone()
    }

    pub fn supports_gpu_color_conversion(&self) -> bool {
        self.device.cast::<ID3D11VideoDevice>().is_ok()
    }

    pub fn copy_sample(&self, sample: &gst::Sample, target: &DrawTarget) -> Result<()> {
        let buffer = sample
            .buffer()
            .ok_or_else(|| Error::Pipeline("Windows video sample has no buffer".into()))?;
        if buffer.n_memory() == 0 {
            return Err(Error::Pipeline(
                "Windows video sample has no D3D11 memory".into(),
            ));
        }
        let memory = buffer.peek_memory(0);
        let memory_ptr = memory.as_ptr() as *mut gst::ffi::GstMemory;
        if unsafe { gst_is_d3d11_memory(memory_ptr) } == 0 {
            return Err(Error::Pipeline(
                "Windows video sample did not negotiate D3D11Memory".into(),
            ));
        }
        let _memory_map = unsafe { D3d11MemoryMap::new(memory_ptr) }?;
        let source_raw = unsafe { gst_d3d11_memory_get_resource_handle(memory_ptr.cast()) };
        let source = unsafe { ID3D11Resource::from_raw_borrowed(&source_raw) }
            .ok_or_else(|| Error::Pipeline("GStreamer returned no D3D11 texture".into()))?;
        let source_subresource =
            unsafe { gst_d3d11_memory_get_subresource_index(memory_ptr.cast()) };
        let keyed_mutex: IDXGIKeyedMutex = target
            .resource
            .cast()
            .map_err(texture_error("query the WebView2 texture mutex"))?;
        unsafe {
            keyed_mutex
                .AcquireSync(0, 1_000)
                .map_err(texture_error("acquire the WebView2 texture"))?;
            gst_d3d11_device_lock(self.gst_device.0);
        }
        unsafe {
            if source_subresource == 0 {
                self.context.CopyResource(&target.resource, source);
            } else {
                self.context.CopySubresourceRegion(
                    &target.resource,
                    0,
                    0,
                    0,
                    0,
                    source,
                    source_subresource,
                    None,
                );
            }
            self.context.Flush();
        }
        unsafe {
            gst_d3d11_device_unlock(self.gst_device.0);
            keyed_mutex
                .ReleaseSync(0)
                .map_err(texture_error("release the WebView2 texture"))?;
        }
        Ok(())
    }

    pub fn acquire(&mut self, width: u32, height: u32) -> Result<Option<DrawTarget>> {
        let width = width.max(1);
        let height = height.max(1);
        if *self.texture_size.read() != Some((width, height)) {
            self.create_pool(width, height)?;
            return Ok(None);
        }
        if let Some(target) = self.free.lock().pop() {
            return Ok(Some(target));
        }
        self.reclaim()?;
        Ok(None)
    }

    pub fn present(&self, target: DrawTarget, timestamp_ns: u64) -> Result<()> {
        let stream = self.stream.clone();
        let free = Arc::clone(&self.free);
        let texture_size = Arc::clone(&self.texture_size);
        (self.dispatch)(Box::new(move || {
            let result = unsafe {
                target
                    .texture
                    .set_timestamp(timestamp_ns)
                    .and_then(|_| stream.present_texture(&target.texture))
            };
            if let Err(error) = result {
                tracing::warn!(%error, "failed to present a WebView2 video texture");
                free.lock().push(target);
                return;
            }
            reclaim_available(&stream, &free, &texture_size);
        }))
    }

    fn create_pool(&mut self, width: u32, height: u32) -> Result<()> {
        if self.pool_pending.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let stream = self.stream.clone();
        let free = Arc::clone(&self.free);
        let texture_size = Arc::clone(&self.texture_size);
        let pending = Arc::clone(&self.pool_pending);
        let dispatch_result = (self.dispatch)(Box::new(move || {
            let result: Result<()> = (|| {
                for old in free.lock().drain(..) {
                    unsafe { stream.0.close_texture(&old.texture) }
                        .map_err(texture_error("retire an old WebView2 video texture"))?;
                }
                let mut targets = Vec::with_capacity(MAX_TEXTURES as usize);
                for _ in 0..MAX_TEXTURES {
                    let texture = unsafe { stream.create_texture(width, height) }
                        .map_err(texture_error("allocate a WebView2 video texture"))?;
                    targets.push(unsafe { draw_target(texture) }?);
                }
                *free.lock() = targets;
                *texture_size.write() = Some((width, height));
                Ok(())
            })();
            if let Err(error) = result {
                tracing::warn!(%error, "failed to allocate the WebView2 video texture pool");
            }
            pending.store(false, Ordering::Release);
        }));
        if dispatch_result.is_err() {
            self.pool_pending.store(false, Ordering::Release);
        }
        dispatch_result
    }

    fn reclaim(&self) -> Result<()> {
        if self.reclaim_pending.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let stream = self.stream.clone();
        let free = Arc::clone(&self.free);
        let texture_size = Arc::clone(&self.texture_size);
        let pending = Arc::clone(&self.reclaim_pending);
        let dispatch_result = (self.dispatch)(Box::new(move || {
            reclaim_available(&stream, &free, &texture_size);
            pending.store(false, Ordering::Release);
        }));
        if dispatch_result.is_err() {
            self.reclaim_pending.store(false, Ordering::Release);
        }
        dispatch_result
    }
}

fn reclaim_available(
    stream: &SendStream,
    free: &Mutex<Vec<DrawTarget>>,
    texture_size: &RwLock<Option<(u32, u32)>>,
) {
    while let Ok(texture) = unsafe { stream.0.get_available_texture() } {
        match unsafe { draw_target(texture) } {
            Ok(target) => {
                let expected = *texture_size.read();
                let actual = unsafe { resource_desc(&target.resource) }
                    .ok()
                    .map(|desc| (desc.Width, desc.Height));
                if actual == expected {
                    free.lock().push(target);
                } else {
                    let _ = unsafe { stream.0.close_texture(&target.texture) };
                }
            }
            Err(error) => tracing::warn!(%error, "failed to reclaim a WebView2 video texture"),
        }
    }
}

unsafe fn draw_target(texture: ICoreWebView2ExperimentalTexture) -> Result<DrawTarget> {
    let resource = unsafe { texture.resource() }
        .map_err(texture_error("get a WebView2 video texture resource"))?;
    let desc = unsafe { resource_desc(&resource) }
        .map_err(texture_error("inspect a WebView2 video texture"))?;
    if desc.Format != windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12 {
        return Err(Error::Pipeline(format!(
            "WebView2 created unsupported video texture format {:?}",
            desc.Format
        )));
    }
    Ok(DrawTarget { texture, resource })
}

unsafe fn gst_device_for_adapter(
    adapter_luid: u64,
) -> Result<(
    ID3D11Device,
    ID3D11DeviceContext,
    gst::Context,
    SendGstDevice,
)> {
    unsafe { gst_d3d11_memory_init_once() };
    let gst_device = unsafe { gst_d3d11_device_new_for_adapter_luid(adapter_luid as i64, 0) };
    if gst_device.is_null() {
        return Err(Error::Pipeline(
            "GStreamer could not create a device on WebView2's adapter".into(),
        ));
    }
    let device_raw = unsafe { gst_d3d11_device_get_device_handle(gst_device) };
    let context_raw = unsafe { gst_d3d11_device_get_device_context_handle(gst_device) };
    let device = unsafe { ID3D11Device::from_raw_borrowed(&device_raw) }
        .cloned()
        .ok_or_else(|| Error::Pipeline("GStreamer returned no D3D11 device".into()))?;
    let device_context = unsafe { ID3D11DeviceContext::from_raw_borrowed(&context_raw) }
        .cloned()
        .ok_or_else(|| Error::Pipeline("GStreamer returned no D3D11 device context".into()))?;
    let context = unsafe { gst_d3d11_context_new(gst_device) };
    if context.is_null() {
        return Err(Error::Pipeline(
            "GStreamer could not create a D3D11 device context".into(),
        ));
    }
    Ok((
        device,
        device_context,
        unsafe { from_glib_full(context) },
        SendGstDevice(gst_device),
    ))
}

unsafe fn resource_desc(
    resource: &ID3D11Resource,
) -> windows::core::Result<windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC> {
    let texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = resource.cast()?;
    let mut desc = unsafe { std::mem::zeroed() };
    unsafe { texture.GetDesc(&mut desc) };
    Ok(desc)
}

#[link(name = "gstd3d11-1.0")]
unsafe extern "C" {
    fn gst_d3d11_memory_init_once();
    fn gst_d3d11_device_new_for_adapter_luid(adapter_luid: i64, flags: u32) -> *mut c_void;
    fn gst_d3d11_device_get_device_handle(device: *mut c_void) -> *mut c_void;
    fn gst_d3d11_device_get_device_context_handle(device: *mut c_void) -> *mut c_void;
    fn gst_d3d11_device_lock(device: *mut c_void);
    fn gst_d3d11_device_unlock(device: *mut c_void);
    fn gst_d3d11_context_new(device: *mut c_void) -> *mut gst::ffi::GstContext;
    fn gst_is_d3d11_memory(memory: *mut gst::ffi::GstMemory) -> i32;
    fn gst_d3d11_memory_get_resource_handle(memory: *mut c_void) -> *mut c_void;
    fn gst_d3d11_memory_get_subresource_index(memory: *mut c_void) -> u32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn texture_error(context: &'static str) -> impl FnOnce(windows::core::Error) -> Error {
    move |error| Error::Pipeline(format!("failed to {context}: {error}"))
}

windows::core::imp::define_interface!(
    ICoreWebView2ExperimentalEnvironment12,
    ICoreWebView2ExperimentalEnvironment12_Vtbl,
    0x96c27a45_f142_4873_80ad_9d0cd899b2b9
);
windows::core::imp::interface_hierarchy!(ICoreWebView2ExperimentalEnvironment12, IUnknown);

impl ICoreWebView2ExperimentalEnvironment12 {
    unsafe fn create_texture_stream(
        &self,
        stream_id: PCWSTR,
        device: &IUnknown,
    ) -> windows::core::Result<ICoreWebView2ExperimentalTextureStream> {
        unsafe {
            let mut result = std::ptr::null_mut();
            (Interface::vtable(self).CreateTextureStream)(
                Interface::as_raw(self),
                stream_id,
                Interface::as_raw(device),
                &mut result,
            )
            .and_then(|| windows::core::Type::from_abi(result))
        }
    }

    unsafe fn render_adapter_luid(&self) -> windows::core::Result<u64> {
        unsafe {
            let mut result = 0;
            (Interface::vtable(self).get_RenderAdapterLUID)(Interface::as_raw(self), &mut result)
                .map(|| result)
        }
    }
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct ICoreWebView2ExperimentalEnvironment12_Vtbl {
    base__: IUnknown_Vtbl,
    CreateTextureStream:
        unsafe extern "system" fn(*mut c_void, PCWSTR, *mut c_void, *mut *mut c_void) -> HRESULT,
    get_RenderAdapterLUID: unsafe extern "system" fn(*mut c_void, *mut u64) -> HRESULT,
    add_RenderAdapterLUIDChanged:
        unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_RenderAdapterLUIDChanged: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
}

windows::core::imp::define_interface!(
    ICoreWebView2ExperimentalTexture,
    ICoreWebView2ExperimentalTexture_Vtbl,
    0x0836f09c_34bd_47bf_914a_99fb56ae2d07
);
windows::core::imp::interface_hierarchy!(ICoreWebView2ExperimentalTexture, IUnknown);

impl ICoreWebView2ExperimentalTexture {
    unsafe fn resource(&self) -> windows::core::Result<ID3D11Resource> {
        unsafe {
            let mut resource = std::ptr::null_mut();
            (Interface::vtable(self).get_Resource)(Interface::as_raw(self), &mut resource).ok()?;
            let resource: IUnknown = windows::core::Type::from_abi(resource)?;
            resource.cast()
        }
    }

    unsafe fn set_timestamp(&self, value: u64) -> windows::core::Result<()> {
        unsafe { (Interface::vtable(self).put_Timestamp)(Interface::as_raw(self), value).ok() }
    }
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct ICoreWebView2ExperimentalTexture_Vtbl {
    base__: IUnknown_Vtbl,
    get_Handle: unsafe extern "system" fn(*mut c_void, *mut HANDLE) -> HRESULT,
    get_Resource: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
    get_Timestamp: unsafe extern "system" fn(*mut c_void, *mut u64) -> HRESULT,
    put_Timestamp: unsafe extern "system" fn(*mut c_void, u64) -> HRESULT,
}

windows::core::imp::define_interface!(
    ICoreWebView2ExperimentalTextureStream,
    ICoreWebView2ExperimentalTextureStream_Vtbl,
    0xafca8431_633f_4528_abfe_7fc3bedd8962
);
windows::core::imp::interface_hierarchy!(ICoreWebView2ExperimentalTextureStream, IUnknown);

impl ICoreWebView2ExperimentalTextureStream {
    unsafe fn add_allowed_origin(
        &self,
        origin: PCWSTR,
        allow_web_texture: bool,
    ) -> windows::core::Result<()> {
        unsafe {
            (Interface::vtable(self).AddAllowedOrigin)(
                Interface::as_raw(self),
                origin,
                allow_web_texture.into(),
            )
            .ok()
        }
    }

    unsafe fn create_texture(
        &self,
        width: u32,
        height: u32,
    ) -> windows::core::Result<ICoreWebView2ExperimentalTexture> {
        unsafe {
            let mut result = std::ptr::null_mut();
            (Interface::vtable(self).CreateTexture)(
                Interface::as_raw(self),
                width,
                height,
                &mut result,
            )
            .and_then(|| windows::core::Type::from_abi(result))
        }
    }

    unsafe fn get_available_texture(
        &self,
    ) -> windows::core::Result<ICoreWebView2ExperimentalTexture> {
        unsafe {
            let mut result = std::ptr::null_mut();
            (Interface::vtable(self).GetAvailableTexture)(Interface::as_raw(self), &mut result)
                .and_then(|| windows::core::Type::from_abi(result))
        }
    }

    unsafe fn close_texture(
        &self,
        texture: &ICoreWebView2ExperimentalTexture,
    ) -> windows::core::Result<()> {
        unsafe {
            (Interface::vtable(self).CloseTexture)(
                Interface::as_raw(self),
                Interface::as_raw(texture),
            )
            .ok()
        }
    }

    unsafe fn present_texture(
        &self,
        texture: &ICoreWebView2ExperimentalTexture,
    ) -> windows::core::Result<()> {
        unsafe {
            (Interface::vtable(self).PresentTexture)(
                Interface::as_raw(self),
                Interface::as_raw(texture),
            )
            .ok()
        }
    }
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct ICoreWebView2ExperimentalTextureStream_Vtbl {
    base__: IUnknown_Vtbl,
    get_Id: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
    AddAllowedOrigin: unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT,
    RemoveAllowedOrigin: unsafe extern "system" fn(*mut c_void, PCWSTR) -> HRESULT,
    add_StartRequested: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_StartRequested: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
    add_Stopped: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_Stopped: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
    CreateTexture: unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> HRESULT,
    GetAvailableTexture: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
    CloseTexture: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
    PresentTexture: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
    Stop: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    add_ErrorReceived: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_ErrorReceived: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
    SetD3DDevice: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
    add_WebTextureReceived:
        unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_WebTextureReceived: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
    add_WebTextureStreamStopped:
        unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i64) -> HRESULT,
    remove_WebTextureStreamStopped: unsafe extern "system" fn(*mut c_void, i64) -> HRESULT,
}
