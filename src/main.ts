import fs from 'fs'
import path from 'path'
import axios, { AxiosResponse } from 'axios'
import { RateLimiter } from 'limiter'

const WaniKaniURL = 'https://api.wanikani.com/v2/'

/*
-Things to cache-
Subjects: Almost never changes.
ReviewStatistics: Updates sometimes. 
*/
let cache: any = {}

async function loadCache() {
    const files = await fs.promises.readdir('cache/')
    for(const file in files) {
        let key = files[file].replace('.json', '')
        let pathname = path.join('cache', files[file])
        let json = await fs.promises.readFile(pathname, 'utf-8')
        let value = JSON.parse(json)
        cache[key] = value
    }

}

async function setCache(key: string, value: object) {
    let oldCacheEntry = cache[key] || {}
    let oldJSON = JSON.stringify(oldCacheEntry)
    let newJSON = JSON.stringify(value)
    if(oldJSON != newJSON) {
        //Update required
        let filename = `cache/${key}.json`
        cache[key] = value
        await fs.promises.writeFile(filename, newJSON)
    }
}

function getCacheValueIfSet(key: string): any | null {
    return cache[key] || null
}

async function getOrInitializeCache(key: string, initializer: ()=>Promise<any>): Promise<any> {
    let currentCacheValue = cache[key]
    if(currentCacheValue != undefined) return Promise.resolve(currentCacheValue)

    let initialValue = await initializer()

    await setCache(key, initialValue)

    return initialValue
}

const token: string = JSON.parse(fs.readFileSync('token.json', 'utf-8')).token

// Note: We are not allowed to make more than 59 requests per minute
const limiter = new RateLimiter(59, 'minute')

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

interface CharacterImage {
    url: string,
    content_type: 'image/png' | 'image/svg+xml'
}

interface RadicalSubject {
    character_images: Array<CharacterImage>
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

interface Assignment {
    srs_stage: number,
    subject_id: number,
    subject_type: 'kanji' | 'radical' | 'vocabulary'
}

function getWaniKani<T>(path: string, params: any, ifModifiedSince: string | undefined = undefined): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        limiter.removeTokens(1, (err, remainingRequests) => {
            let headers: any = {
                Authorization: 'Bearer ' + token
            }
            if (ifModifiedSince !== undefined) {
                headers['If-Modified-Since'] = ifModifiedSince
            }
            axios.get(`${WaniKaniURL}${path}`, {
                headers: headers,
                params: params
            })
                .then(response => {
                    if (response.status == 304) {
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

async function getSubjects(ids: Array<number>): Promise<Array<Resource<Subject>>> {
    let subjectIdsNotCached: Array<number> = ids.filter(id => getCacheValueIfSet(`subject-${id}`) == null)
    if(subjectIdsNotCached.length > 0) {
        const newAssignmentsCollection = await getWaniKani<Collection<Subject>>('subjects', { ids: subjectIdsNotCached.join(',')})
        if(newAssignmentsCollection != null) {
            const newSubjects = await unwrapCollection(newAssignmentsCollection)
            for(const subject of newSubjects) {
                await setCache(`subject-${subject.id}`, subject)
            }
        } else {
            throw Error('Assignments collection was null')
        }
    }
    return ids.map(id => getCacheValueIfSet(`subject-${id}`) as Resource<Subject>)
}

async function getAssignments(subjectIds: Array<number>, getAllAssignments: boolean = false): Promise<Array<Resource<Assignment>>> {
    if (!getAllAssignments && subjectIds.length == 0) { return [] }

    let dateLastUpdated = await getOrInitializeCache('AssignmentsDate', () => Promise.resolve({ date: undefined }))
    dateLastUpdated = dateLastUpdated.date

    let oldAssignments: any = await getOrInitializeCache('Assignments', () => Promise.resolve({}))

    let requestArgs: any = {}

    if(dateLastUpdated) {
        requestArgs['updated_after'] = dateLastUpdated
    }

    let newAssignmentsCollection = await getWaniKani<Collection<Assignment>>('assignments', requestArgs)
    if (newAssignmentsCollection !== null) {
        let updatedAssignments = await unwrapCollection(newAssignmentsCollection)
        dateLastUpdated = newAssignmentsCollection.data_updated_at
        updatedAssignments.forEach(assignment => {
            oldAssignments[assignment.data.subject_id] = assignment
        })
    }

    await setCache('AssignmentsDate', { date: dateLastUpdated })
    await setCache('Assignments', oldAssignments)

    let returnKeys = getAllAssignments ? Object.keys(oldAssignments) : Object.keys(oldAssignments).filter(key => { return subjectIds.includes(parseInt(key)) })
    return returnKeys.map(key => {
        return oldAssignments[key]
    })
}

async function unwrapCollection<T>(pageOne: Collection<T>): Promise<Array<Resource<T>>> {
    let result: Array<Resource<T>> = pageOne.data
    let currentPage = pageOne
    while (currentPage.pages.next_url != null) {
        let requestPath = currentPage.pages.next_url.replace(WaniKaniURL, '')
        let nextPage = await getWaniKani<Collection<T>>(requestPath, {})
        if (nextPage != null) {
            result = result.concat(nextPage.data)
            currentPage = nextPage
        } else {
            break
        }
    }
    return result
}

async function getReviewStatistics(): Promise<Array<Resource<ReviewStatistics>>> {
    let dateLastUpdated = await getOrInitializeCache('reviewStatsDate', () => {
        return Promise.resolve({ date: undefined })
    })
    if (dateLastUpdated) {
        dateLastUpdated = dateLastUpdated.date
    }
    let oldReviewStatistics = await getOrInitializeCache('reviewStats', () => {
        return Promise.resolve({})
    })
    if (dateLastUpdated) {
        let updatedReviewStatsCollection = await getWaniKani<Collection<ReviewStatistics>>('review_statistics', { updated_after: dateLastUpdated }, dateLastUpdated)
        if (updatedReviewStatsCollection !== null) {
            let updatedReviewStats = await unwrapCollection(updatedReviewStatsCollection)
            dateLastUpdated = updatedReviewStatsCollection.data_updated_at
            updatedReviewStats.forEach(reviewStat => {
                oldReviewStatistics[reviewStat.id] = reviewStat
            })
        }
    } else {
        let newReviewCollection = await getWaniKani<Collection<ReviewStatistics>>('review_statistics', {})
        if (newReviewCollection !== null) {
            let updatedReviewStats = await unwrapCollection(newReviewCollection)
            dateLastUpdated = newReviewCollection.data_updated_at
            updatedReviewStats.forEach(reviewStat => {
                oldReviewStatistics[reviewStat.id] = reviewStat
            })
        }
    }
    await setCache('reviewStatsDate', { date: dateLastUpdated })
    await setCache('reviewStats', oldReviewStatistics)

    return Object.values(oldReviewStatistics)
}

function csvLine(question: string, answers: Array<string>, comment: string, instructions: string, renderAsImage: boolean): string {
    return `${question},${answers.length == 1 ? answers[0] : '"'+answers.join(',')+'"'},"${comment}",${instructions},${renderAsImage ? 'Image' : 'Text'}\n`
}

const csvHeader = 'Question,Answers,Comment,Instructions,Render as\n'

function createCSV(kanjiMeaningSubjects: Array<Resource<Subject & KanjiSubject>>, kanjiReadingSubjects: Array<Resource<Subject & KanjiSubject>>, vocabularyMeaningSubjects: Array<Resource<Subject & VocabularySubject>>, vocabularyReadingSubjects: Array<Resource<Subject & VocabularySubject>>, radicalMeaningSubjects: Array<Resource<Subject & RadicalSubject>>): string {
    let csvString = csvHeader
    kanjiMeaningSubjects.forEach(subject => {
        csvString += csvLine('「'+subject.data.characters+'」', subject.data.meanings.map(meaning => { return meaning.meaning }), `Readings: ${subject.data.readings.map(reading => reading.reading).join(', ')}\nView this kanji on WaniKani: <${subject.data.document_url}>`, 'What is the **meaning** of this Kanji?', true)
    })
    kanjiReadingSubjects.forEach(subject => {
        csvString += csvLine(subject.data.characters, subject.data.readings.map(reading => { return reading.reading }), `Meanings: ${subject.data.meanings.map(meaning => meaning.meaning).join(', ')}\nView this kanji on WaniKani: <${subject.data.document_url}>`, 'What is the **reading** of this Kanji?', true)
    })
    vocabularyMeaningSubjects.forEach(subject => {
        csvString += csvLine('「'+subject.data.characters+'」', subject.data.meanings.map(meaning => { return meaning.meaning }), `Readings: ${subject.data.readings.map(reading => reading.reading).join(', ')}\nView this vocabulary word on WaniKani: <${subject.data.document_url}>`, 'What is the **meaning** of this vocabulary word?', true)
    })
    vocabularyReadingSubjects.forEach(subject => {
        csvString += csvLine(subject.data.characters, subject.data.readings.map(reading => { return reading.reading }), `Meanings: ${subject.data.meanings.map(meaning => meaning.meaning).join(', ')}\nView this vocabulary word on WaniKani: <${subject.data.document_url}>`, 'What is the **reading** of this vocabulary word?', true)
    })
    radicalMeaningSubjects.forEach(subject => {
        if(subject.data.characters == null) {
            csvString += csvLine(subject.data.character_images.filter(image => image.content_type == 'image/png')[0].url, subject.data.meanings.map(meaning => { return meaning.meaning }), `View this radical on WaniKani: <${subject.data.document_url}>`, 'What is the **meaning** of this radical?', false)
        } else {
            csvString += csvLine(subject.data.characters, subject.data.meanings.map(meaning => { return meaning.meaning }), `View this radical on WaniKani: <${subject.data.document_url}>`, 'What is the **meaning** of this radical?', true)
        }
    })
    return csvString
}

const maxCurrentLevel = 5
const minIncorrectCount = 2

async function main() {
    process.stdout.write('Loading cache from disk... ')
    await loadCache()
    console.log('Done!\n')

    process.stdout.write('Downloading new review statistics... ')
    let reviewStats = await getReviewStatistics()
    console.log('Done!\n')

    // Leech Kanji Meaning

    console.log('Detecting leeches... ')
    let leechKanjiMeaningSubjectIds = reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'kanji' && reviewStat.data.meaning_incorrect >= minIncorrectCount
    }).map(entry => {
        return entry.data.subject_id
    })

    let leechKanjiMeaningAssignments = await getAssignments(leechKanjiMeaningSubjectIds)

    let leechKanjiMeaningSubjects = await getSubjects(leechKanjiMeaningAssignments.filter(assignment => {
        return assignment.data.srs_stage <= maxCurrentLevel
    }).map(assignment => {
        return assignment.data.subject_id
    })) as Array<Resource<Subject & KanjiSubject>>
    console.log(`...${leechKanjiMeaningSubjects.length} kanji meaning leeches detected...`)

    // Leech Kanji Reading

    let leechKanjiReadingSubjectIds = reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'kanji' && reviewStat.data.reading_incorrect >= minIncorrectCount
    }).map(entry => {
        return entry.data.subject_id
    })

    let leechKanjiReadingAssignments = await getAssignments(leechKanjiReadingSubjectIds)

    let leechKanjiReadingSubjects = await getSubjects(leechKanjiReadingAssignments.filter(assignment => {
        return assignment.data.srs_stage <= maxCurrentLevel
    }).map(assignment => {
        return assignment.data.subject_id
    })) as Array<Resource<Subject & KanjiSubject>>
    console.log(`...${leechKanjiReadingSubjects.length} kanji reading leeches detected...`)

    // Leech Vocabulary Meaning

    let leechVocabularyMeaningSubjectIds = reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'vocabulary' && reviewStat.data.meaning_incorrect >= minIncorrectCount
    }).map(entry => {
        return entry.data.subject_id
    })

    let leechVocabularyMeaningAssignments = await getAssignments(leechVocabularyMeaningSubjectIds)

    let leechVocabularyMeaningSubjects = await getSubjects(leechVocabularyMeaningAssignments.filter(assignment => {
        return assignment.data.srs_stage <= maxCurrentLevel
    }).map(assignment => {
        return assignment.data.subject_id
    })) as Array<Resource<Subject & VocabularySubject>>
    console.log(`...${leechVocabularyMeaningSubjects.length} vocabulary meaning leeches detected...`)

    // Leech Vocabulary Reading

    let leechVocabularyReadingSubjectIds = reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'vocabulary' && reviewStat.data.reading_incorrect >= minIncorrectCount
    }).map(entry => {
        return entry.data.subject_id
    })

    let leechVocabularyReadingAssignments = await getAssignments(leechVocabularyReadingSubjectIds)

    let leechVocabularyReadingSubjects = await getSubjects(leechVocabularyReadingAssignments.filter(assignment => {
        return assignment.data.srs_stage <= maxCurrentLevel
    }).map(assignment => {
        return assignment.data.subject_id
    })) as Array<Resource<Subject & VocabularySubject>>
    console.log(`...${leechVocabularyReadingSubjects.length} vocabulary reading leeches detected...`)

    // Leech Radical Meaning

    let leechRadicalMeaningSubjectIds = reviewStats.filter(reviewStat => {
        return reviewStat.data.subject_type == 'radical' && reviewStat.data.reading_incorrect >= minIncorrectCount
    }).map(entry => {
        return entry.data.subject_id
    })

    let leechRadicalMeaningAssignments = await getAssignments(leechRadicalMeaningSubjectIds)

    let leechRadicalMeaningSubjects = await getSubjects(leechRadicalMeaningAssignments.filter(assignment => {
        return assignment.data.srs_stage <= maxCurrentLevel
    }).map(assignment => {
        return assignment.data.subject_id
    })) as Array<Resource<Subject & RadicalSubject>>
    console.log(`...${leechRadicalMeaningSubjects.length} radical meaning leeches detected...`)
    console.log('...Done!\n')

    // Level One Kanji, Vocabulary, and Radicals
    console.log('Retrieving level one SRS kanji and vocabulary...')
    let allAssignments = await getAssignments([], true)
    let levelOneKanjiSubjectIds = allAssignments.filter(assignment => {
        return assignment.data.srs_stage == 1 && assignment.data.subject_type == 'kanji'
    }).map(assignment => {
        return assignment.data.subject_id
    })
    let levelOneVocabularySubjectIds = allAssignments.filter(assignment => {
        return assignment.data.srs_stage == 1 && assignment.data.subject_type == 'vocabulary'
    }).map(assignment => {
        return assignment.data.subject_id
    })
    let levelOneRadicalSubjectIds = allAssignments.filter(assignment => {
        return assignment.data.srs_stage == 1 && assignment.data.subject_type == 'radical'
    }).map(assignment => {
        return assignment.data.subject_id
    })

    let levelOneKanjiSubjects = await getSubjects(levelOneKanjiSubjectIds)
    console.log(`...${levelOneKanjiSubjects.length} level one kanji subjects retrieved...`)

    let levelOneVocabularySubjects = await getSubjects(levelOneVocabularySubjectIds)
    console.log(`...${levelOneVocabularySubjects.length} level one vocabulary subjects retrieved...`)

    let levelOneRadicalSubjects = await getSubjects(levelOneRadicalSubjectIds)
    console.log(`...${levelOneRadicalSubjects.length} level one radical subjects retrieved...`)
    console.log('...Done!\n')


    // Creating CSV files
    console.log('Generating and writing decks...')

    let leechReviewCSV = createCSV(leechKanjiMeaningSubjects, leechKanjiReadingSubjects, leechVocabularyMeaningSubjects, leechVocabularyReadingSubjects, leechRadicalMeaningSubjects)
    let levelOneReviewCSV = createCSV(levelOneKanjiSubjects as Array<Resource<Subject & KanjiSubject>>, levelOneKanjiSubjects as Array<Resource<Subject & KanjiSubject>>, levelOneVocabularySubjects as Array<Resource<Subject & VocabularySubject>>, levelOneVocabularySubjects as Array<Resource<Subject & VocabularySubject>>, levelOneRadicalSubjects as Array<Resource<Subject & RadicalSubject>>)

    await fs.promises.writeFile('WaniKaniLeeches.csv', leechReviewCSV)
    await fs.promises.writeFile('WaniKaniLevelOne.csv', levelOneReviewCSV)

    console.log('...Done!\n')
}
main()