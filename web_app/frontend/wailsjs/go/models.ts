export namespace main {
	
	export class FilePayload {
	    filename: string;
	    contentType: string;
	    data: string;
	
	    static createFrom(source: any = {}) {
	        return new FilePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.contentType = source["contentType"];
	        this.data = source["data"];
	    }
	}
	export class FileTreeNode {
	    name: string;
	    path: string;
	    type: string;
	    size: number;
	    mtime: number;
	
	    static createFrom(source: any = {}) {
	        return new FileTreeNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.type = source["type"];
	        this.size = source["size"];
	        this.mtime = source["mtime"];
	    }
	}
	export class FileTreeResponse {
	    root: string;
	    tree: FileTreeNode[];
	
	    static createFrom(source: any = {}) {
	        return new FileTreeResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.tree = this.convertValues(source["tree"], FileTreeNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GatewayQueueStats {
	    queued: number;
	    running: number;
	
	    static createFrom(source: any = {}) {
	        return new GatewayQueueStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.queued = source["queued"];
	        this.running = source["running"];
	    }
	}
	export class GatewayTaskSnapshot {
	    id: string;
	    user?: string;
	    session?: string;
	    status: string;
	    workspace?: string;
	    log_dir?: string;
	    raw_log_path?: string;
	    started_at?: string;
	    ended_at?: string;
	    exit_code?: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new GatewayTaskSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.user = source["user"];
	        this.session = source["session"];
	        this.status = source["status"];
	        this.workspace = source["workspace"];
	        this.log_dir = source["log_dir"];
	        this.raw_log_path = source["raw_log_path"];
	        this.started_at = source["started_at"];
	        this.ended_at = source["ended_at"];
	        this.exit_code = source["exit_code"];
	        this.error = source["error"];
	    }
	}
	export class GatewayAgentStatus {
	    task?: GatewayTaskSnapshot;
	    output?: string;
	    running?: boolean;
	    queue_stats?: GatewayQueueStats;
	    status?: string;
	
	    static createFrom(source: any = {}) {
	        return new GatewayAgentStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.task = this.convertValues(source["task"], GatewayTaskSnapshot);
	        this.output = source["output"];
	        this.running = source["running"];
	        this.queue_stats = this.convertValues(source["queue_stats"], GatewayQueueStats);
	        this.status = source["status"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GatewayInvokeRequest {
	    query: string;
	    mode?: string;
	
	    static createFrom(source: any = {}) {
	        return new GatewayInvokeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.mode = source["mode"];
	    }
	}
	export class GatewayLoginRequest {
	    user_name: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new GatewayLoginRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user_name = source["user_name"];
	        this.password = source["password"];
	    }
	}
	export class GatewayLoginResult {
	    token: string;
	    expires_at: string;
	    user: string;
	    sources: string[];
	
	    static createFrom(source: any = {}) {
	        return new GatewayLoginResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.token = source["token"];
	        this.expires_at = source["expires_at"];
	        this.user = source["user"];
	        this.sources = source["sources"];
	    }
	}
	
	export class GatewaySessionAgent {
	    status: string;
	    task?: GatewayTaskSnapshot;
	
	    static createFrom(source: any = {}) {
	        return new GatewaySessionAgent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.task = this.convertValues(source["task"], GatewayTaskSnapshot);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GatewaySession {
	    session_id: string;
	    user?: string;
	    sources: string[];
	    last_active?: string;
	    last_active_nanos?: number;
	    agent?: GatewaySessionAgent;
	
	    static createFrom(source: any = {}) {
	        return new GatewaySession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.session_id = source["session_id"];
	        this.user = source["user"];
	        this.sources = source["sources"];
	        this.last_active = source["last_active"];
	        this.last_active_nanos = source["last_active_nanos"];
	        this.agent = this.convertValues(source["agent"], GatewaySessionAgent);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class GatewaySessionsResponse {
	    user: string;
	    sessions: GatewaySession[];
	
	    static createFrom(source: any = {}) {
	        return new GatewaySessionsResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user = source["user"];
	        this.sessions = this.convertValues(source["sessions"], GatewaySession);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GatewaySnapshot {
	    path?: string;
	    size?: number;
	    returned?: number;
	    truncated?: boolean;
	    content?: string;
	    source?: string;
	    files?: string[];
	
	    static createFrom(source: any = {}) {
	        return new GatewaySnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.size = source["size"];
	        this.returned = source["returned"];
	        this.truncated = source["truncated"];
	        this.content = source["content"];
	        this.source = source["source"];
	        this.files = source["files"];
	    }
	}
	export class GatewaySourceInfo {
	    name: string;
	    files: string[];
	
	    static createFrom(source: any = {}) {
	        return new GatewaySourceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.files = source["files"];
	    }
	}
	
	export class ProxyRequest {
	    method: string;
	    path: string;
	    body?: string;
	    headers?: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new ProxyRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.method = source["method"];
	        this.path = source["path"];
	        this.body = source["body"];
	        this.headers = source["headers"];
	    }
	}
	export class TransportMeta {
	    mode?: string;
	    cache?: string;
	    build_ms?: number;
	    response_ms?: number;
	    payload_bytes?: number;
	    modules_count?: number;
	
	    static createFrom(source: any = {}) {
	        return new TransportMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.cache = source["cache"];
	        this.build_ms = source["build_ms"];
	        this.response_ms = source["response_ms"];
	        this.payload_bytes = source["payload_bytes"];
	        this.modules_count = source["modules_count"];
	    }
	}
	export class ProxyResponse {
	    status: number;
	    body: string;
	    etag?: string;
	    notModified?: boolean;
	    transport?: TransportMeta;
	
	    static createFrom(source: any = {}) {
	        return new ProxyResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.body = source["body"];
	        this.etag = source["etag"];
	        this.notModified = source["notModified"];
	        this.transport = this.convertValues(source["transport"], TransportMeta);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class UploadResult {
	    path: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new UploadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	    }
	}
	export class UploadedFile {
	    filename: string;
	    data: string;
	
	    static createFrom(source: any = {}) {
	        return new UploadedFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.data = source["data"];
	    }
	}
	export class WorkspaceDirUploadResult {
	    root: string;
	    extracted: number;
	    total_bytes: number;
	    skipped_symlinks: number;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceDirUploadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.extracted = source["extracted"];
	        this.total_bytes = source["total_bytes"];
	        this.skipped_symlinks = source["skipped_symlinks"];
	    }
	}
	export class WorkspaceUploadItem {
	    path: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceUploadItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.size = source["size"];
	    }
	}
	export class WorkspaceUploadResult {
	    root: string;
	    uploaded: WorkspaceUploadItem[];
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceUploadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.uploaded = this.convertValues(source["uploaded"], WorkspaceUploadItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

