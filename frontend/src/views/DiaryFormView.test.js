import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiaryFormView from './DiaryFormView.vue'

const mocks = vi.hoisted(() => ({
  route: { params: {}, query: {} },
  push: vi.fn(),
  diary: { fetchEntry: vi.fn(), saveEntry: vi.fn(), updateEntry: vi.fn() },
  uploadImages: vi.fn()
}))
vi.mock('vue-router', async importOriginal => ({
  ...await importOriginal(),
  useRouter: () => ({ push: mocks.push }),
  useRoute: () => mocks.route
}))
vi.mock('@/stores/diary', () => ({ useDiaryStore: () => mocks.diary }))
vi.mock('@/stores/diaryTemplate', () => ({ useDiaryTemplateStore: () => ({}) }))
vi.mock('@/services/imageUpload', () => ({ uploadImages: mocks.uploadImages }))
vi.mock('@/composables/useNotification', () => ({
  useNotification: () => ({ showSuccess: vi.fn(), showError: vi.fn() })
}))
vi.mock('@/composables/useAuthedImage', () => ({
  useAuthedImage: () => ({ hasError: () => false, urlFor: () => '' })
}))

let wrapper
function openForm() {
  wrapper = mount(DiaryFormView, {
    attachTo: document.body,
    global: { stubs: { RouterLink: true, SymbolAutocomplete: true, BaseSelect: true } }
  })
  return flushPromises()
}
function button(label) {
  return wrapper.findAll('button').find(item => item.text() === label)
}
async function selectImages(names) {
  await button('Add images').trigger('click')
  await vi.waitFor(() => expect(wrapper.find('input[type=file]').exists()).toBe(true))
  const input = wrapper.get('input[type=file]')
  const files = names.map(name => new File(['image'], name, { type: 'image/png' }))
  Object.defineProperty(input.element, 'files', { configurable: true, value: files })
  await input.trigger('change')
  await vi.waitFor(() => expect(wrapper.text()).toContain(names.at(-1)))
}
function response(images) {
  return { data: { images, successfulUploads: images.filter(image => !image.error).length, totalImages: images.length } }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.route.params = {}
})
afterEach(() => wrapper?.unmount())

describe('saving a journal entry with attachments', () => {
  it('uploads hidden pending files and retries only failures on the same entry after editing its text', async () => {
    await openForm()
    const names = ['first.png', 'second.png']
    await selectImages(names)
    await button('Hide').trigger('click')
    expect(button('Choose files').isVisible()).toBe(false)

    mocks.diary.saveEntry.mockResolvedValue({ id: 'new-entry' })
    let finishUpload
    mocks.uploadImages.mockImplementationOnce(() => new Promise(resolve => { finishUpload = resolve }))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('button[type=submit]').text()).toBe('Uploading images…')
    expect(mocks.uploadImages.mock.calls[0][1].map(file => file.name)).toEqual(names)
    await wrapper.get('form').trigger('submit')
    expect(mocks.diary.saveEntry).toHaveBeenCalledTimes(1)
    finishUpload(response([{ id: 'saved', file_name: names[0] }, { filename: names[1], error: 'Upload interrupted' }]))
    await flushPromises()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(wrapper.get('[role=alert]').text()).toContain('Entry saved')
    expect(button('Choose files').isVisible()).toBe(true)

    await wrapper.get('input[placeholder="Enter a title for your entry..."]').setValue('Revised title')
    mocks.uploadImages.mockResolvedValueOnce(response([{ id: 'second', file_name: names[1] }]))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.diary.saveEntry).toHaveBeenCalledTimes(1)
    expect(mocks.diary.updateEntry).toHaveBeenCalledWith('new-entry', expect.objectContaining({ title: 'Revised title' }))
    expect(mocks.uploadImages.mock.calls[1][0]).toBe('/diary/new-entry/images')
    expect(mocks.uploadImages.mock.calls[1][1].map(file => file.name)).toEqual([names[1]])
    expect(mocks.push).toHaveBeenCalledWith('/diary')
  })

  it('keeps an existing entry and pending files after an upload error and retries without resaving unchanged text', async () => {
    mocks.route.params = { id: 'existing-entry' }
    mocks.diary.fetchEntry.mockResolvedValue({ id: 'existing-entry', title: 'My entry' })
    await openForm()
    await selectImages(['chart.png'])
    mocks.uploadImages.mockRejectedValueOnce(new Error('Offline'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('Entry saved')
    expect(mocks.push).not.toHaveBeenCalled()
    mocks.uploadImages.mockResolvedValueOnce(response([{ id: 'chart', file_name: 'chart.png' }]))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.diary.updateEntry).toHaveBeenCalledTimes(1)
    expect(mocks.diary.saveEntry).not.toHaveBeenCalled()
    expect(mocks.uploadImages).toHaveBeenCalledTimes(2)
    expect(mocks.push).toHaveBeenCalledWith('/diary')
  })
})
