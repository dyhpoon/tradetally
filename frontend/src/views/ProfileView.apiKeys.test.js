import { shallowMount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/services/api', () => ({ default: api }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { username: 'tester', role: 'admin', email: 'test@example.com' } })
}))
vi.mock('@/composables/useNotification', () => ({
  useNotification: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showDangerConfirmation: vi.fn() })
}))
vi.mock('@/composables/useProAccess', () => ({
  useProAccess: () => ({ isProUser: { value: true } })
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { tab: 'security' } }),
  useRouter: () => ({ replace: vi.fn() })
}))

import ProfileView from './ProfileView.vue'

let wrapper
let keys

beforeEach(() => {
  keys = []
  api.get.mockImplementation(async (url) => {
    if (url === '/billing/status') return { data: { data: { billing_available: false } } }
    if (url === '/api-keys') return { data: { apiKeys: keys } }
    if (url === '/auth/passkey') return { data: { passkeys: [] } }
    return { data: {} }
  })
  api.post.mockImplementation(async (_url, body) => {
    const key = { ...body, id: 'test-key', key: 'example-key', keyPrefix: 'example', isActive: true }
    keys = [key]
    return { data: { apiKey: key } }
  })
})

afterEach(() => wrapper?.unmount())

function button(text, scope = wrapper) {
  return scope.findAll('button').find(node => node.text() === text)
}

async function openForm() {
  wrapper = shallowMount(ProfileView)
  await flushPromises()
  await button('Create API Key').trigger('click')
  await wrapper.get('#apiKeyName').setValue('Futu hourly sync')
}

async function submit() {
  await wrapper.get('[role="dialog"] form').trigger('submit')
  await flushPromises()
}

describe('profile API key permissions', () => {
  it('limits a trades-only key to two scopes even after broader permissions were selected', async () => {
    await openForm()
    await wrapper.get('#permWrite').setValue(true)
    await wrapper.get('#permAdmin').setValue(true)
    await wrapper.get('#permTradesOnly').setValue(true)
    expect(wrapper.find('#permAdmin').exists()).toBe(false)
    await submit()
    expect(api.post).toHaveBeenCalledWith('/api-keys', {
      name: 'Futu hourly sync', permissions: [], scopes: ['trades:read', 'trades:write'], expiresIn: null
    })
    expect(wrapper.get('[role="dialog"]').text()).toContain('trades:read, trades:write')
    await button('Done').trigger('click')
    expect(wrapper.text()).toContain('trades:read, trades:write')
    await button('Create API Key').trigger('click')
    expect(wrapper.get('#permTradesOnly').element.checked).toBe(false)
    expect(wrapper.get('#permRead').element.checked).toBe(true)
  })

  it('allows a scoped key when no broad permission is selected', async () => {
    await openForm()
    await wrapper.get('#permRead').setValue(false)
    expect(wrapper.get('[role="dialog"] button[type="submit"]').element.disabled).toBe(true)
    await wrapper.get('#permTradesOnly').setValue(true)
    expect(wrapper.get('[role="dialog"] button[type="submit"]').element.disabled).toBe(false)
    await submit()
    expect(api.post.mock.calls[0][1].permissions).toEqual([])
    expect(api.post.mock.calls[0][1].scopes).toEqual(['trades:read', 'trades:write'])
  })

  it('retains the existing broad permissions when trades-only is switched off', async () => {
    await openForm()
    await wrapper.get('#permWrite').setValue(true)
    await wrapper.get('#permTradesOnly').setValue(true)
    await wrapper.get('#permTradesOnly').setValue(false)
    await submit()
    expect(api.post).toHaveBeenCalledWith('/api-keys', {
      name: 'Futu hourly sync', permissions: ['read', 'write'], expiresIn: null
    })
    expect(wrapper.get('[role="dialog"]').text()).toContain('read, write')
  })

  it('resets a cancelled selection before another key is created', async () => {
    await openForm()
    await wrapper.get('#permTradesOnly').setValue(true)
    await button('Cancel', wrapper.get('[role="dialog"]')).trigger('click')
    await button('Create API Key').trigger('click')
    expect(wrapper.get('#apiKeyName').element.value).toBe('')
    expect(wrapper.get('#permTradesOnly').element.checked).toBe(false)
    expect(wrapper.get('#permRead').element.checked).toBe(true)
  })
})
