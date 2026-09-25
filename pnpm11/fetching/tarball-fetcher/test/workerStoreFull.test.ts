import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from '@jest/globals'
import { fixtures } from '@pnpm/test-fixtures'
import { temporaryDirectory } from 'tempy'

test('worker store write ENOSPC does not retry the tarball', () => {
  const tempDir = temporaryDirectory()
  try {
    const storeDir = path.join(tempDir, 'store')
    fs.mkdirSync(storeDir)
    const preload = path.join(tempDir, 'full-store.cjs')
    fs.writeFileSync(preload, `
      const { isMainThread } = require('node:worker_threads')
      if (!isMainThread) {
        const fs = require('node:fs')
        const original = fs.writeFileSync
        original(process.env.PNPM_TEST_FULL_STORE_MARKER, 'worker loaded')
        fs.writeFileSync = function (file, data, options) {
          if (typeof file === 'string' &&
              file.startsWith(process.env.PNPM_TEST_FULL_STORE_PREFIX) &&
              options?.flag === 'wx') {
            const error = new Error('no space left on device')
            error.code = 'ENOSPC'
            throw error
          }
          return original.apply(this, arguments)
        }
      }
    `)
    const runner = `
      import fs from 'node:fs'
      import path from 'node:path'
      import { createRequire } from 'node:module'
      import { pathToFileURL } from 'node:url'
      const resolve = createRequire(path.join(process.env.PNPM_TEST_PACKAGE_DIR, 'package.json'))
      const load = async (name) => import(pathToFileURL(resolve.resolve(name)).href)
      const { createFetchFromRegistry } = await load('@pnpm/network.fetch')
      const { createCafsStore } = await load('@pnpm/store.create-cafs-store')
      const { StoreIndex } = await load('@pnpm/store.index')
      const { createTarballFetcher } = await load('@pnpm/fetching.tarball-fetcher')
      const { finishWorkers } = await load('@pnpm/worker')
      const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await load('undici')

      const originalDispatcher = getGlobalDispatcher()
      const agent = new MockAgent()
      agent.disableNetConnect()
      setGlobalDispatcher(agent)
      const content = fs.readFileSync(process.env.PNPM_TEST_TARBALL_PATH)
      agent.get('http://example.com').intercept({ path: '/foo.tgz', method: 'GET' })
        .reply(200, content, { headers: { 'Content-Length': String(content.length) } })
        .times(2)
      const storeDir = process.env.PNPM_TEST_STORE_DIR
      const index = new StoreIndex(storeDir)
      try {
        const fetch = createTarballFetcher(createFetchFromRegistry({}), () => undefined, {
          storeIndex: index,
          retry: { maxTimeout: 100, minTimeout: 0, retries: 1 },
        })
        const error = await fetch.remoteTarball(createCafsStore(storeDir), {
          integrity: 'sha1-HssnaJydJVE+rbyZFKc/VAi+enY=',
          tarball: 'http://example.com/foo.tgz',
        }, {
          filesIndexFile: path.join(storeDir, 'index.json'),
          lockfileDir: process.cwd(),
          pkg: {},
        }).then(() => undefined, (error) => error)
        console.log(JSON.stringify({
          code: error?.code,
          pending: agent.pendingInterceptors().length,
          workerPreloaded: fs.existsSync(process.env.PNPM_TEST_FULL_STORE_MARKER),
        }))
      } finally {
        index.close()
        await agent.close()
        setGlobalDispatcher(originalDispatcher)
        await finishWorkers()
      }
    `
    const runnerFile = path.join(tempDir, 'store-write.mjs')
    fs.writeFileSync(runnerFile, runner)
    const output = execFileSync(process.execPath, ['--require', preload, runnerFile], {
      cwd: path.join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PNPM_TEST_PACKAGE_DIR: path.join(import.meta.dirname, '..'),
        PNPM_TEST_FULL_STORE_PREFIX: path.join(storeDir, 'files') + path.sep,
        PNPM_TEST_FULL_STORE_MARKER: path.join(storeDir, 'worker-preloaded'),
        PNPM_TEST_STORE_DIR: storeDir,
        PNPM_TEST_TARBALL_PATH: fixtures(import.meta.dirname).find('babel-helper-hoist-variables-6.24.1.tgz'),
      },
      encoding: 'utf8',
      timeout: 45_000,
    })
    expect(JSON.parse(output.trim())).toEqual({
      code: 'ERR_PNPM_ENOSPC',
      pending: 1,
      workerPreloaded: true,
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}, 60_000)
