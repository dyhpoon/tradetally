import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiaryImageUpload from './DiaryImageUpload.vue'
import { uploadImages } from '@/services/imageUpload'

vi.mock('@/services/imageUpload', () => ({ uploadImages: vi.fn() }))
vi.mock('@/services/api', () => ({ default: { defaults: { baseURL: '/api' } } }))

let wrapper
let input

function selectFiles(files) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change'))
}

function image(name, contents) {
  return new File([contents], name, { type: 'image/png' })
}

beforeEach(() => {
  let nextUrl = 0
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:preview-' + ++nextUrl
    static revokeObjectURL = vi.fn()
  })
  uploadImages.mockReset()
  wrapper = mount(DiaryImageUpload)
  input = wrapper.get('input[type=file]').element
})

afterEach(() => {
  wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('journal image uploads', () => {
  it('queues files immediately and retries only failed files, including files with identical names', async () => {
    const first = image('chart.png', 'first chart')
    const second = image('chart.png', 'second chart')
    selectFiles([first, second])
    expect(wrapper.vm.hasPendingFiles()).toBe(true)
    const saved = { id: 'attachment', file_name: 'chart.png' }
    uploadImages.mockResolvedValueOnce({ data: { images: [saved, { filename: 'chart.png', error: 'Upload failed' }] } })

    expect((await wrapper.vm.uploadPendingImages('entry')).success).toBe(false)
    expect(wrapper.emitted('uploaded')).toEqual([[[saved]]])
    expect(wrapper.vm.getPendingFiles().map(i => i.file)).toEqual([second])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2')

    uploadImages.mockResolvedValueOnce({ data: { images: [{ id: 'second-attachment' }] } })
    expect((await wrapper.vm.uploadPendingImages('entry')).success).toBe(true)
    expect(uploadImages.mock.calls[1][1][0]).toBe(second)
    expect(uploadImages.mock.calls[1][1]).toHaveLength(1)
    expect(wrapper.vm.hasPendingFiles()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2')
  })

  it('keeps the active batch stable when a user drops more files or submits again', async () => {
    const original = image('trade.png', 'original')
    selectFiles([original])
    let finishUpload
    uploadImages.mockImplementation(() => new Promise(resolve => { finishUpload = resolve }))
    const active = wrapper.vm.uploadPendingImages('entry')
    await wrapper.vm.$nextTick()
    expect(input.disabled).toBe(true)
    expect(wrapper.get('button[aria-label="Remove trade.png"]').element.disabled).toBe(true)
    await wrapper.get('.border-dashed').trigger('drop', { dataTransfer: { files: [image('another.png', 'later')] } })
    expect((await wrapper.vm.uploadPendingImages('entry')).success).toBe(false)
    expect(uploadImages).toHaveBeenCalledTimes(1)

    finishUpload({ data: { images: [] } })
    expect((await active).success).toBe(false)
    expect(wrapper.vm.getPendingFiles().map(i => i.file)).toEqual([original])
    expect(wrapper.emitted('uploaded')).toBeUndefined()
    expect(wrapper.text()).toContain('Image upload was not confirmed')
  })
})
