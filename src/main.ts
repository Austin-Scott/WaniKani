import fs from 'fs'
import axios, { AxiosResponse } from 'axios'
import { RateLimiter } from 'limiter'
import cacheManager from 'cache-manager'
import fsStore from 'cache-manager-fs-binary'
import { isMainThread } from 'worker_threads'

const WaniKaniURL = 'https://api.wanikani.com/v2/'

/*
-Things to cache-
Subjects: Almost never changes.
ReviewStatistics: Updates sometimes. 
*/
const cache = cacheManager.caching({
    store: fsStore,
    ttl: 60 * 60 * 24 * 365 * 100 /* seconds, set to 100 years. Never expire. */,
    path: 'cache',
    fillcallback: main
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
    data: Array<Resource<T>>
}

interface AuxiliaryMeaning {
    meaning: string,
    type: 'whitelist' | 'blacklist'
}

interface Meaning {
    meaning: string,
    primary: boolean,
    accepted_answer: boolean
}

interface Subject {
    auxiliary_meanings: Array<AuxiliaryMeaning>,
    characters: string,
    created_at: string,
    document_url: string,
    hidden_at: string,
    lesson_position: number,
    level: number,
    meaning_mnemonic: string,
    meanings: Array<Meaning>,
    slug: string
}

interface KanjiReading {
    reading: string,
    primary: boolean,
    accepted_answer: boolean,
    type: string
}

interface KanjiSubject {
    amalgamation_subject_ids: Array<number>,
    component_subject_ids: Array<number>,
    readings: Array<KanjiReading>,
    visually_similar_subject_ids: Array<number>
}

interface VocabularyReading {
    accepted_answer: boolean,
    primary: boolean,
    reading: string
}

interface VocabularySubject {
    meaning_mnemonic: string,
    parts_of_speech: Array<string>,
    readings: Array<VocabularyReading>,
    reading_mnemonic: string
}

interface ReviewStatistics {
    created_at: string,
    hidden: boolean,
    meaning_correct: number,
    meaning_current_streak: number,
    meaning_incorrect: number,
    meaning_max_streak: number,
    percentage_correct: number,
    reading_correct: number,
    reading_current_streak: number,
    reading_incorrect: number,
    reading_max_streak: number,
    subject_id: number,
    subject_type: 'kanji' | 'radical' | 'vocabulary'
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
            axios.get(`${WaniKaniURL}${path}`, {
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

async function getSubject(id: number): Promise<Resource<Subject>> {
    let key = 'subject:'+id
    return cache.wrap(key, ()=>{
        return getWaniKani<Resource<Subject>>(`subjects/${id}`, {})
    })
}

async function unwrapCollection<T>(pageOne: Collection<T>): Promise<Array<Resource<T>>> {
    let result: Array<Resource<T>> = pageOne.data
    let currentPage = pageOne
    while(currentPage.pages.next_url != null) {
        let requestPath = currentPage.pages.next_url.replace(WaniKaniURL, '')
        let nextPage = await getWaniKani<Collection<T>>(requestPath, {})
        if(nextPage != null) {
            result = result.concat(nextPage.data)
            currentPage = nextPage
        } else {
            break
        }
    }
    return result
}

async function getReviewStatistics(): Promise<Array<Resource<ReviewStatistics>>> {
    let dateLastUpdated = await cache.wrap('reviewStatsDate', ()=> {
        return Promise.resolve({date: undefined})
    })
    if(dateLastUpdated) {
        dateLastUpdated = dateLastUpdated.date
    }
    let oldReviewStatistics = await cache.wrap('reviewStats', ()=>{
        return Promise.resolve({})
    })
    if(dateLastUpdated) {
        let updatedReviewStatsCollection = await getWaniKani<Collection<ReviewStatistics>>('review_statistics', { updated_after: dateLastUpdated }, dateLastUpdated)
        if(updatedReviewStatsCollection !== null) {
            let updatedReviewStats = await unwrapCollection(updatedReviewStatsCollection)
            dateLastUpdated = updatedReviewStatsCollection.data_updated_at
            updatedReviewStats.forEach(reviewStat => {
                oldReviewStatistics[reviewStat.id] = reviewStat
            })
        }
    } else {
        let newReviewCollection = await getWaniKani<Collection<ReviewStatistics>>('review_statistics', {})
        if(newReviewCollection !== null) {
            let updatedReviewStats = await unwrapCollection(newReviewCollection)
            dateLastUpdated = newReviewCollection.data_updated_at
            updatedReviewStats.forEach(reviewStat => {
                oldReviewStatistics[reviewStat.id] = reviewStat
            })
        }
    }
    await cache.set('reviewStatsDate', { date: dateLastUpdated }, { ttl: 60 * 60 * 24 * 365 * 100})
    await cache.set('reviewStats', oldReviewStatistics, { ttl: 60 * 60 * 24 * 365 * 100})

    return Object.values(oldReviewStatistics)
}

const maxCurrentStreak = 2
const minIncorrectCount = 3

async function main() {
    let reviewStats = await getReviewStatistics()

    let leechKanjiMeanings = await Promise.all(reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'kanji' && reviewStat.data.meaning_current_streak <= maxCurrentStreak && reviewStat.data.meaning_incorrect >= minIncorrectCount
    }).map(entry => {
        return getSubject(entry.data.subject_id)
    })) as Array<Resource<Subject & KanjiSubject>>

    let leechKanjiReadings = await Promise.all(reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'kanji' && reviewStat.data.reading_current_streak <= maxCurrentStreak && reviewStat.data.reading_incorrect >= minIncorrectCount
    }).map(entry => {
        return getSubject(entry.data.subject_id)
    })) as Array<Resource<Subject & KanjiSubject>>

    let leechVocabularyMeanings = await Promise.all(reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'vocabulary' && reviewStat.data.meaning_current_streak <= maxCurrentStreak && reviewStat.data.meaning_incorrect >= minIncorrectCount
    }).map(entry => {
        return getSubject(entry.data.subject_id)
    })) as Array<Resource<Subject & VocabularySubject>>

    let leechVocabularyReadings = await Promise.all(reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'vocabulary' && reviewStat.data.reading_current_streak <= maxCurrentStreak && reviewStat.data.reading_incorrect >= minIncorrectCount
    }).map(entry => {
        return getSubject(entry.data.subject_id)
    })) as Array<Resource<Subject & VocabularySubject>>

    console.log(leechKanjiMeanings)
}