import fs from 'fs'
import axios, { AxiosResponse } from 'axios'
import { RateLimiter } from 'limiter'
import cacheManager from 'cache-manager'
import fsStore from 'cache-manager-fs-binary'
import { isMainThread } from 'worker_threads'

/*
-Things to cache-
Subjects: Almost never change.
Reviews: Never change once created.
Assignments: Changes moderately, but still should be cached none the less
*/
const cache = cacheManager.caching({
    store: fsStore,
    reviveBuffers: true,
    binaryAsStream: true,
    ttl: 60 * 60 * 24 * 365 * 100 /* seconds, set to 100 years. Never expire. */,
    maxsize: 1000 * 1000 * 1000 /* max size in bytes on disk */,
    path: 'cache',
    preventfill: true
})

const token: string = JSON.parse(fs.readFileSync('token.json', 'utf-8')).token

// Note: We are not allowed to make more than 60 requests per minute
const limiter = new RateLimiter(60, 'minute')

interface Resource<T> {
    id: number,
    object: string,
    url: string,
    data_updated_at: string,
    data: T
}

interface Collection<T> {
    object: string,
    url: string,
    pages: {
        next_url: string | null,
        previous_url: string | null,
        per_page: number
    },
    total_count: number,
    data_updated_at: string,
    data: Array<T>
}

function getWaniKani<T>(path: string, params: any, ifModifiedSince: string | undefined = undefined): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        limiter.removeTokens(1, (err, remainingRequests) => {
            let headers: any = {
                Authorization: 'Bearer ' + token
            }
            if(ifModifiedSince !== undefined) {
                headers['If-Modified-Since'] = ifModifiedSince
            }
            axios.get(`https://api.wanikani.com/v2/${path}`, {
                headers: headers,
                params: params
            })
                .then(response => {
                    if(response.status == 304) {
                        // The information has not changed since the last request
                        resolve(null)
                    } else {
                        resolve(response.data)
                    }
                })
                .catch(err => reject(err))
        })
    })
}

async function main() {
    let assignments = await getWaniKani<any>('assignments', {})
    console.log(assignments)
}
main()