// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Log, Viewer } from '@microsoft/sarif-web-component'
import { AppInsights } from "applicationinsights-js"
import { CommonServiceIds, getClient, IProjectPageService } from 'azure-devops-extension-api'
import { BuildRestClient, BuildServiceIds, IBuildPageDataService } from 'azure-devops-extension-api/Build'
import * as SDK from 'azure-devops-extension-sdk'
import * as JSZip from 'jszip'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react'
import * as React from 'react'
import * as ReactDOM from 'react-dom'

const isProduction = self !== top
const perfLoadStart = performance.now() // For telemetry.

@observer class Tab extends React.Component {
	@observable.ref logs = undefined as Log[]
	@observable pipelineId = undefined as string
	@observable user = undefined as string
	constructor(props) {
		super(props)
		SDK.init({
			applyTheme: true,
			loaded: true,
		})
		;(async () => {
			await SDK.ready()
			console.info('Version', SDK.getExtensionContext().version)

			const user = SDK.getUser()
			const organization = SDK.getHost().name
			if (isProduction) {
				AppInsights.setAuthenticatedUserContext(user.name /* typically email */, organization)
			}

			const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService)
			const project = await projectService.getProject()

			const buildPageDataService = await SDK.getService<IBuildPageDataService>(BuildServiceIds.BuildPageDataService)
			const buildPageData = await buildPageDataService.getBuildPageData()
			if (!buildPageData) {
				SDK.notifyLoadSucceeded()
				AppInsights.trackException(new Error('buildPageData undefined'))
				return
			}
			const { build, definition } = buildPageData

			const buildClient = getClient(BuildRestClient)

			// Otherwise consumed by: /WebPlatform/Web/extensions/vss-web/vss-platform/Trace.ts
			const artifacts = await buildClient.getArtifacts(project.id, build.id)
			const files = await (async () => {
				if (!artifacts.some(a => a.name === 'CodeAnalysisLogs')) return []
				const arrayBuffer = await buildClient.getArtifactContentZip(project.id, build.id, 'CodeAnalysisLogs')
				const zip = await JSZip.loadAsync(arrayBuffer)
				return Object.values<any>(zip.files)
					.filter(entry => !entry.dir && entry.name.endsWith('.sarif'))
					.map((entry, i) => {
						let cachedPromise = undefined as string
						return {
							key:   i,
							text:  entry.name.replace('CodeAnalysisLogs/', ''),
							sarif: () => cachedPromise = cachedPromise || entry.async('string') as string
						}
					})
			})()

			const logTexts = await Promise.all(files.map(async file => await file.sarif()))

			// Some logs are: Unexpected token ﻿ in JSON at position 0
			const logs = logTexts.map(log => {
				try {
					return JSON.parse(log) as Log
				} catch(e) {
					AppInsights.trackException(e, null, { logSnippet: JSON.stringify(log.slice(0, 100)) })
					return undefined
				}
			}).filter(log => log)

			const toolNames = logs.map(log => {
				return log.runs
					.filter(run => run.tool.driver) // Guard against old versions.
					.map(run => run.tool.driver.name)
			})
			const toolNamesSet = new Set([].concat(...toolNames))

			// Show file names when the tool names are homogeneous.
			if (files.length > 1 && toolNamesSet.size === 1) {
				logs.forEach((log, i) => 
					log.runs.forEach(run => {
						run.properties = run.properties || {}
						run.properties['logFileName'] = files[i].text
					})
				)
			}

			runInAction(() => {
				this.logs = logs
				this.pipelineId = `${organization}.${definition.id}`
				this.user = user.name
			})
			
			SDK.notifyLoadSucceeded()

			if (isProduction) {
				const customDimensions = {
					logLength: logs.length + '',
					toolNames: [...toolNamesSet.values()].join(' '),
					version: SDK.getExtensionContext().version,
				}
				AppInsights.trackPageView(project.name, document.referrer, customDimensions, undefined, performance.now() - perfLoadStart)
			}
		})()
	}
	render() {
		const {logs, user} = this
		const filterState = {
			Baseline: { value: ['new', 'updated', 'absent'] },
			Level: { value: ['error', 'warning'] },
		}
		return !logs || logs.length
			? <Viewer logs={logs} filterState={filterState} user={user} />
			: <div className="full">No SARIF artifacts found.</div>
	}
}

if (isProduction) {
	AppInsights.downloadAndSetup({ instrumentationKey: '' })
	addEventListener('unhandledrejection', e => AppInsights.trackException(e.reason))
}
ReactDOM.render(<Tab />, document.getElementById("app"))
