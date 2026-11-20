import api from './api'

const uploadOptions = { timeout: 300000 }

async function uploadDirectFile(endpoint, file) {
  const { data } = await api.post(`${endpoint}/upload-token`, {
    filename: file.name,
    size: file.size
  })
  const { put } = await import('@vercel/blob/client')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), uploadOptions.timeout)
  try {
    await put(data.pathname, file, {
      access: 'private',
      token: data.clientToken,
      contentType: data.contentType,
      multipart: file.size > 8 * 1024 * 1024,
      abortSignal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Image upload timed out. Please try again.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
  return api.post(endpoint, { uploadReceipt: data.receipt }, uploadOptions)
}

export async function uploadImages(endpoint, files) {
  if (files.length > 10) throw new Error('Upload up to 10 images at a time')
  if (import.meta.env.VITE_IMAGE_STORAGE_PROVIDER !== 'vercel-blob') {
    const formData = new FormData()
    files.forEach(file => formData.append('images', file))
    return api.post(endpoint, formData, uploadOptions)
  }

  // Finalize one image at a time so the server processes at most 50 MB per request.
  const images = []
  for (const file of files) {
    try {
      const response = await uploadDirectFile(endpoint, file)
      const result = response.data?.images
      if (result?.length !== 1 || !(result[0]?.id || result[0]?.error)) {
        throw new Error('The server did not confirm this image upload')
      }
      images.push(result[0])
    } catch (error) {
      images.push({ filename: file.name, error: error.response?.data?.error || error.message || 'Image upload failed' })
    }
  }
  return { data: { images, totalImages: images.length, successfulUploads: images.filter(image => !image.error).length } }
}

export function uploadAvatar(file) {
  if (import.meta.env.VITE_IMAGE_STORAGE_PROVIDER === 'vercel-blob') {
    return uploadDirectFile('/users/avatar', file)
  }
  const formData = new FormData()
  formData.append('avatar', file)
  return api.post('/users/avatar', formData, uploadOptions)
}
