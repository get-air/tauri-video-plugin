use windows::{
    core::Interface,
    Win32::{
        Foundation::{HANDLE, HMODULE, HWND},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView,
                ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
                D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
            },
            DirectComposition::{
                DCompositionCreateDevice, IDCompositionDevice, IDCompositionScaleTransform,
                IDCompositionTarget, IDCompositionVisual,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
                },
                IDXGIDevice, IDXGIFactory2, IDXGIKeyedMutex, IDXGIResource, IDXGISwapChain1,
                DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
                DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT,
            },
        },
    },
};

use crate::{Error, Result};

pub struct DCompPresenter {
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    swapchain: IDXGISwapChain1,
    dcomp_device: IDCompositionDevice,
    _target: IDCompositionTarget,
    _root: IDCompositionVisual,
    visual: IDCompositionVisual,
    scale_transform: IDCompositionScaleTransform,
    shared_texture: ID3D11Texture2D,
    keyed_mutex: IDXGIKeyedMutex,
    shared_handle: HANDLE,
    width: u32,
    height: u32,
}

// D3D11 was created without SINGLETHREADED and every access to this presenter
// is serialized by the owning mutex, including resize and frame presentation.
unsafe impl Send for DCompPresenter {}
unsafe impl Sync for DCompPresenter {}

impl DCompPresenter {
    pub fn new(hwnd: HWND, x: i32, y: i32, width: u32, height: u32) -> Result<Self> {
        let mut device = None;
        let mut context = None;
        let mut feature_level = D3D_FEATURE_LEVEL::default();
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )
        }
        .map_err(dcomp_error("create the D3D11 device"))?;
        let device = device.ok_or_else(|| Error::Pipeline("D3D11 returned no device".into()))?;
        let context = context.ok_or_else(|| Error::Pipeline("D3D11 returned no context".into()))?;
        let dxgi_device: IDXGIDevice = device
            .cast()
            .map_err(dcomp_error("query the DXGI device"))?;
        let adapter =
            unsafe { dxgi_device.GetAdapter() }.map_err(dcomp_error("query the DXGI adapter"))?;
        let factory: IDXGIFactory2 =
            unsafe { adapter.GetParent() }.map_err(dcomp_error("query the DXGI factory"))?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width.max(1),
            Height: height.max(1),
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: 0,
        };
        let swapchain = unsafe { factory.CreateSwapChainForComposition(&device, &desc, None) }
            .map_err(dcomp_error("create the composition swap chain"))?;
        let (shared_texture, keyed_mutex, shared_handle) =
            create_shared_texture(&device, width.max(1), height.max(1))?;
        let dcomp_device: IDCompositionDevice =
            unsafe { DCompositionCreateDevice(&dxgi_device) }
                .map_err(dcomp_error("create the DirectComposition device"))?;
        let target = unsafe { dcomp_device.CreateTargetForHwnd(hwnd, false) }
            .map_err(dcomp_error("create the DirectComposition target"))?;
        let root = unsafe { dcomp_device.CreateVisual() }
            .map_err(dcomp_error("create the root visual"))?;
        let visual = unsafe { dcomp_device.CreateVisual() }
            .map_err(dcomp_error("create the video visual"))?;
        let scale_transform = unsafe { dcomp_device.CreateScaleTransform() }
            .map_err(dcomp_error("create the video scale transform"))?;
        unsafe {
            scale_transform
                .SetScaleX2(1.0)
                .and_then(|_| scale_transform.SetScaleY2(1.0))
                .and_then(|_| scale_transform.SetCenterX2(width as f32 / 2.0))
                .and_then(|_| scale_transform.SetCenterY2(height as f32 / 2.0))
                .and_then(|_| visual.SetTransform(&scale_transform))
                .and_then(|_| visual.SetContent(&swapchain))
                .and_then(|_| visual.SetOffsetX2(x as f32))
                .and_then(|_| visual.SetOffsetY2(y as f32))
                .and_then(|_| root.AddVisual(&visual, true, None))
                .and_then(|_| target.SetRoot(&root))
                .and_then(|_| dcomp_device.Commit())
        }
        .map_err(dcomp_error("attach the DirectComposition video visual"))?;
        let presenter = Self {
            _device: device,
            context,
            swapchain,
            dcomp_device,
            _target: target,
            _root: root,
            visual,
            scale_transform,
            shared_texture,
            keyed_mutex,
            shared_handle,
            width: width.max(1),
            height: height.max(1),
        };
        presenter.clear([0.0, 0.0, 0.0, 1.0])?;
        Ok(presenter)
    }

    pub fn place(&mut self, x: i32, y: i32, width: u32, height: u32) -> Result<()> {
        let width = width.max(1);
        let height = height.max(1);
        let resized = width != self.width || height != self.height;
        if resized {
            unsafe {
                self.swapchain.ResizeBuffers(
                    2,
                    width,
                    height,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_SWAP_CHAIN_FLAG(0),
                )
            }
            .map_err(dcomp_error("resize the composition swap chain"))?;
            self.width = width;
            self.height = height;
            let (texture, mutex, handle) = create_shared_texture(&self._device, width, height)?;
            self.shared_texture = texture;
            self.keyed_mutex = mutex;
            self.shared_handle = handle;
        }
        unsafe {
            self.visual
                .SetOffsetX2(x as f32)
                .and_then(|_| self.visual.SetOffsetY2(y as f32))
                .and_then(|_| self.scale_transform.SetCenterX2(width as f32 / 2.0))
                .and_then(|_| self.scale_transform.SetCenterY2(height as f32 / 2.0))
                .and_then(|_| self.dcomp_device.Commit())
        }
        .map_err(dcomp_error("place the DirectComposition video visual"))?;
        if resized {
            self.clear([0.0, 0.0, 0.0, 1.0])?;
        }
        Ok(())
    }

    pub fn set_zoom(&mut self, scale: f32) -> Result<()> {
        let scale = scale.clamp(1.0, 2.0);
        unsafe {
            self.scale_transform
                .SetScaleX2(scale)
                .and_then(|_| self.scale_transform.SetScaleY2(scale))
                .and_then(|_| self.dcomp_device.Commit())
        }
        .map_err(dcomp_error("zoom the DirectComposition video visual"))
    }

    pub fn reset(&mut self) -> Result<()> {
        self.set_zoom(1.0)?;
        self.clear([0.0, 0.0, 0.0, 1.0])
    }

    pub fn shared_draw_info(&self) -> (u64, u32) {
        (
            self.shared_handle.0 as usize as u64,
            D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32,
        )
    }

    pub fn present_shared(&self) -> Result<()> {
        let backbuffer: ID3D11Texture2D = unsafe { self.swapchain.GetBuffer(0) }
            .map_err(dcomp_error("get the composition backbuffer"))?;
        unsafe {
            self.keyed_mutex
                .AcquireSync(0, u32::MAX)
                .map_err(dcomp_error("acquire the shared video texture"))?;
            self.context.CopyResource(&backbuffer, &self.shared_texture);
            self.keyed_mutex
                .ReleaseSync(0)
                .map_err(dcomp_error("release the shared video texture"))?;
            self.swapchain.Present(0, DXGI_PRESENT(0)).ok()
        }
        .map_err(dcomp_error("present the shared video texture"))
    }

    fn clear(&self, color: [f32; 4]) -> Result<()> {
        use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

        let buffer: ID3D11Texture2D = unsafe { self.swapchain.GetBuffer(0) }
            .map_err(dcomp_error("get the composition backbuffer"))?;
        let mut view: Option<ID3D11RenderTargetView> = None;
        unsafe {
            self._device
                .CreateRenderTargetView(&buffer, None, Some(&mut view))
                .map_err(dcomp_error("create the composition render target"))?;
            let view = view.ok_or_else(|| {
                Error::Pipeline("D3D11 returned no composition render target".into())
            })?;
            self.context.ClearRenderTargetView(&view, &color);
            self.swapchain.Present(1, DXGI_PRESENT(0)).ok()
        }
        .map_err(dcomp_error("clear the composition video surface"))
    }
}

fn create_shared_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, IDXGIKeyedMutex, HANDLE)> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }
        .map_err(dcomp_error("create the shared video texture"))?;
    let texture =
        texture.ok_or_else(|| Error::Pipeline("D3D11 returned no shared video texture".into()))?;
    let keyed_mutex: IDXGIKeyedMutex = texture
        .cast()
        .map_err(dcomp_error("query the shared texture mutex"))?;
    let resource: IDXGIResource = texture
        .cast()
        .map_err(dcomp_error("query the shared texture handle"))?;
    let handle = unsafe { resource.GetSharedHandle() }
        .map_err(dcomp_error("get the shared video texture handle"))?;
    Ok((texture, keyed_mutex, handle))
}

fn dcomp_error(context: &'static str) -> impl FnOnce(windows::core::Error) -> Error {
    move |error| Error::Pipeline(format!("failed to {context}: {error}"))
}
