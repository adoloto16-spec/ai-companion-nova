use serde::{Deserialize,Serialize};

const CRED_TYPE_GENERIC:u32=1;
const CRED_PERSIST_LOCAL_MACHINE:u32=2;
const ERROR_NOT_FOUND:u32=1168;
const MAX_SECRET_BYTES:usize=5*512;

#[derive(Debug,Deserialize,Serialize,Clone)]
#[serde(deny_unknown_fields)]
pub struct CredentialReference{
    pub id:String,
    pub kind:String,
    pub provider:Option<String>,
    pub version:Option<String>,
}

fn validate_reference(reference:&CredentialReference)->Result<(),String>{
    if reference.kind!="api-key"{return Err("unsupported credential kind".to_string());}
    if reference.provider.as_deref()!=Some("openai-compatible"){return Err("unsupported credential provider".to_string());}
    if reference.id.is_empty()||reference.id.len()>128||!reference.id.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'.'|'_'|'-')){
        return Err("invalid credential reference id".to_string());
    }
    Ok(())
}

fn target_name(reference:&CredentialReference)->Result<String,String>{
    validate_reference(reference)?;
    Ok(format!("AI Companion Nova::openai-compatible::{}",reference.id))
}

pub struct WindowsCredentialStore;

impl WindowsCredentialStore{
    #[cfg(windows)]
    pub fn get_secret(&self,reference:&CredentialReference)->Result<Option<String>,String>{
        use std::ptr::null_mut;
        let target=target_name(reference)?;
        let target_w=wide(&target);
        unsafe{
            let mut credential:*mut CREDENTIALW=null_mut();
            if CredReadW(target_w.as_ptr(),CRED_TYPE_GENERIC,0,&mut credential)==0{
                let error=GetLastError();
                if error==ERROR_NOT_FOUND{return Ok(None);}
                return Err(format!("Windows Credential Manager read failed with code {error}."));
            }
            let blob=if (*credential).CredentialBlobSize==0{
                Vec::new()
            }else{
                std::slice::from_raw_parts((*credential).CredentialBlob,(*credential).CredentialBlobSize as usize).to_vec()
            };
            CredFree(credential as *mut _);
            String::from_utf8(blob).map(Some).map_err(|_|"Stored credential is not valid UTF-8.".to_string())
        }
    }

    #[cfg(not(windows))]
    pub fn get_secret(&self,_reference:&CredentialReference)->Result<Option<String>,String>{
        Err("Windows Credential Manager is unavailable on this platform.".to_string())
    }

    #[cfg(windows)]
    pub fn set_secret(&self,reference:&CredentialReference,secret:&str)->Result<(),String>{
        if secret.is_empty(){return Err("Credential secret must not be empty.".to_string());}
        let blob=secret.as_bytes();
        if blob.len()>MAX_SECRET_BYTES{return Err("Credential secret exceeds the Windows Generic Credential limit of 2560 bytes.".to_string());}
        let target=target_name(reference)?;
        let target_w=wide(&target);
        let user_w=wide("AI Companion Nova");
        let mut blob_copy=blob.to_vec();
        let credential=CREDENTIALW{
            Flags:0,
            Type:CRED_TYPE_GENERIC,
            TargetName:target_w.as_ptr() as *mut _,
            Comment:std::ptr::null_mut(),
            LastWritten:FILETIME{dwLowDateTime:0,dwHighDateTime:0},
            CredentialBlobSize:blob_copy.len() as u32,
            CredentialBlob:blob_copy.as_mut_ptr(),
            Persist:CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount:0,
            Attributes:std::ptr::null_mut(),
            TargetAlias:std::ptr::null_mut(),
            UserName:user_w.as_ptr() as *mut _
        };
        unsafe{
            if CredWriteW(&credential,0)==0{
                return Err(format!("Windows Credential Manager write failed with code {}.",GetLastError()));
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn set_secret(&self,_reference:&CredentialReference,_secret:&str)->Result<(),String>{
        Err("Windows Credential Manager is unavailable on this platform.".to_string())
    }

    #[cfg(windows)]
    pub fn delete_secret(&self,reference:&CredentialReference)->Result<(),String>{
        let target=target_name(reference)?;
        let target_w=wide(&target);
        unsafe{
            if CredDeleteW(target_w.as_ptr(),CRED_TYPE_GENERIC,0)==0{
                let error=GetLastError();
                if error==ERROR_NOT_FOUND{return Ok(());}
                return Err(format!("Windows Credential Manager delete failed with code {error}."));
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn delete_secret(&self,_reference:&CredentialReference)->Result<(),String>{
        Err("Windows Credential Manager is unavailable on this platform.".to_string())
    }

    #[cfg(windows)]
    pub fn exists(&self,reference:&CredentialReference)->Result<bool,String>{
        use std::ptr::null_mut;
        let target=target_name(reference)?;
        let target_w=wide(&target);
        unsafe{
            let mut credential:*mut CREDENTIALW=null_mut();
            if CredReadW(target_w.as_ptr(),CRED_TYPE_GENERIC,0,&mut credential)==0{
                let error=GetLastError();
                if error==ERROR_NOT_FOUND{return Ok(false);}
                return Err(format!("Windows Credential Manager existence check failed with code {error}."));
            }
            CredFree(credential as *mut _);
            Ok(true)
        }
    }

    #[cfg(not(windows))]
    pub fn exists(&self,_reference:&CredentialReference)->Result<bool,String>{
        Err("Windows Credential Manager is unavailable on this platform.".to_string())
    }
}

#[cfg(windows)]
fn wide(value:&str)->Vec<u16>{
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
#[repr(C)]
struct FILETIME{dwLowDateTime:u32,dwHighDateTime:u32}
#[cfg(windows)]
#[repr(C)]
struct CREDENTIAL_ATTRIBUTEW{Keyword:*mut u16,Flags:u32,ValueSize:u32,Value:*mut u8}
#[cfg(windows)]
#[repr(C)]
struct CREDENTIALW{
    Flags:u32,
    Type:u32,
    TargetName:*mut u16,
    Comment:*mut u16,
    LastWritten:FILETIME,
    CredentialBlobSize:u32,
    CredentialBlob:*mut u8,
    Persist:u32,
    AttributeCount:u32,
    Attributes:*mut CREDENTIAL_ATTRIBUTEW,
    TargetAlias:*mut u16,
    UserName:*mut u16,
}

#[cfg(windows)]
#[link(name="Advapi32")]
extern "system"{
    fn CredReadW(target_name:*const u16,type_:u32,flags:u32,credential:*mut *mut CREDENTIALW)->i32;
    fn CredWriteW(credential:*const CREDENTIALW,flags:u32)->i32;
    fn CredDeleteW(target_name:*const u16,type_:u32,flags:u32)->i32;
    fn CredFree(buffer:*mut std::ffi::c_void);
}

#[cfg(windows)]
#[link(name="Kernel32")]
extern "system"{
    fn GetLastError()->u32;
}
