import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import deployment from '../../../vercel.json'
import api from './api'
import { put } from '@vercel/blob/client'
import { uploadImages, uploadAvatar } from './imageUpload'

vi.mock('./api', () => ({ default: { post: vi.fn() } }))
vi.mock('@vercel/blob/client', () => ({ put: vi.fn() }))

beforeEach(() => {
  api.post.mockReset()
  put.mockReset()
  vi.stubEnv('VITE_IMAGE_STORAGE_PROVIDER', 'vercel-blob')
  put.mockResolvedValue({})
})
afterEach(() => vi.unstubAllEnvs())

describe('image uploads', () => {
  it('allows the private Blob transfer API in the deployed browser policy', () => {
    const headers = deployment.services.web.headers.find(rule => rule.source === '/(.*)').headers
    const policy = headers.find(header => header.key === 'Content-Security-Policy').value
    const sources = policy.split(';').map(rule => rule.trim().split(/\s+/)).find(([name]) => name === 'connect-src')
    expect(sources).toContain('https://vercel.com/api/blob/')
    expect(sources).not.toContain('https://vercel.com')
  })

  it('uploads large files directly and sends only receipts to the API, sequentially', async () => {
    const files = [new File([new Uint8Array(9 * 1024 * 1024)], 'large.png'), new File(['small'], 'small.png')]
    const events = []
    api.post.mockImplementation(async (endpoint, data) => {
      if (endpoint.endsWith('/upload-token')) {
        events.push('token:' + data.filename)
        return { data: { pathname: data.filename, clientToken: 'scoped', receipt: data.filename, contentType: 'image/png' } }
      }
      events.push('finalize:' + data.uploadReceipt)
      expect(data).toEqual({ uploadReceipt: expect.any(String) })
      return { data: { images: [{ id: data.uploadReceipt }] } }
    })
    put.mockImplementation(async pathname => { events.push('put:' + pathname) })
    const response = await uploadImages('/trades/1/images', files)
    expect(events).toEqual(['token:large.png', 'put:large.png', 'finalize:large.png', 'token:small.png', 'put:small.png', 'finalize:small.png'])
    expect(put).toHaveBeenCalledWith('large.png', files[0], expect.objectContaining({ access: 'private', token: 'scoped', multipart: true }))
    expect(response.data.successfulUploads).toBe(2)
  })

  it('retains individual failures while completing the remaining images', async () => {
    api.post.mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({ data: { pathname: 'second', clientToken: 'scoped', receipt: 'signed', contentType: 'image/png' } })
      .mockResolvedValueOnce({ data: { images: [{ id: 'second' }] } })
    const response = await uploadImages('/diary/1/images', [new File(['a'], 'a.png'), new File(['b'], 'b.png')])
    expect(response.data).toEqual({ images: [{ filename: 'a.png', error: 'Connection lost' }, { id: 'second' }], totalImages: 2, successfulUploads: 1 })
  })

  it('keeps an unconfirmed image in its slot when the next image succeeds', async () => {
    api.post.mockImplementation(async (endpoint, data) => {
      if (endpoint.endsWith('/upload-token')) return { data: { pathname: data.filename, receipt: data.filename } }
      return { data: { images: data.uploadReceipt === 'a.png' ? [] : [{ id: 'b' }] } }
    })
    const response = await uploadImages('/diary/1/images', [new File(['a'], 'a.png'), new File(['b'], 'b.png')])
    expect(response.data.images).toEqual([{ filename: 'a.png', error: expect.stringContaining('did not confirm') }, { id: 'b' }])
    expect(response.data.successfulUploads).toBe(1)
  })

  it('aborts a stalled transfer and returns a retryable per-file error', async () => {
    vi.useFakeTimers()
    try {
      api.post.mockResolvedValue({ data: { pathname: 'slow.png' } })
      put.mockImplementation((_path, _file, { abortSignal }) => new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      const upload = uploadImages('/diary/1/images', [new File(['x'], 'slow.png')])
      await vi.advanceTimersByTimeAsync(300000)
      expect((await upload).data.images).toEqual([{ filename: 'slow.png', error: expect.stringContaining('timed out') }])
      expect(api.post).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local multipart uploads and the 10-image batch limit', async () => {
    vi.stubEnv('VITE_IMAGE_STORAGE_PROVIDER', '')
    const file = new File(['local'], 'local.png')
    await uploadImages('/trades/1/images', [file])
    expect(api.post.mock.calls[0][1].get('images')).toBe(file)
    expect(put).not.toHaveBeenCalled()
    await expect(uploadImages('/trades/1/images', Array(11).fill(file))).rejects.toThrow('10 images')
  })

  it('uses the avatar token and finalization endpoints', async () => {
    api.post.mockResolvedValueOnce({ data: { pathname: 'avatar', clientToken: 'scoped', receipt: 'signed', contentType: 'image/png' } })
      .mockResolvedValueOnce({ data: { user: { avatar_url: '/api/users/avatar/profile.webp' } } })
    await uploadAvatar(new File(['avatar'], 'avatar.png'))
    expect(api.post).toHaveBeenLastCalledWith('/users/avatar', { uploadReceipt: 'signed' }, { timeout: 300000 })
  })
})
