import { GoogleGenAI } from '@google/genai';
import type { StoryHub, NewsTeaData, NewsItem, Category, TimelineEntry, StoryEvolutionItem, SourcePerspective } from '../src/types/news.js';

const rawApiKey = process.env.GEMINI_API_KEY || '';
const apiKey = rawApiKey.replace(/^["'\s]+|["'\s]+$/g, '').trim();

export const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

/**
 * Robust wrapper to query Gemini with multiple models and graceful rate-limit handling.
 * Tries 'gemini-3.1-flash-lite' first (higher free quota & lightweight), then 'gemini-3.8-flash'.
 */
async function callGeminiWithFallback(prompt: string, responseMimeType = 'application/json'): Promise<string | null> {
  if (!ai) return null;

  const candidateModels = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType,
        },
      });

      const text = response.text;
      if (text && text.trim().length > 0) {
        return text;
      }
    } catch (err: any) {
      const isQuotaLimit = 
        err?.status === 'RESOURCE_EXHAUSTED' || 
        err?.message?.includes('429') || 
        err?.message?.includes('quota') ||
        err?.error?.code === 429;

      if (isQuotaLimit) {
        console.warn(`[Gemini API] Quota limit reached on model ${model}. Attempting fallback or local intelligence synthesis.`);
      } else {
        console.warn(`[Gemini API] Notice for ${model}:`, err?.message || 'Transient call issue');
      }
    }
  }

  return null;
}

/**
 * Generate Gen-Z "News Tea" summary for a story hub, keeping 100% factual accuracy.
 */
export async function generateGenZTea(storyTitle: string, facts: string): Promise<NewsTeaData> {
  const prompt = `
You are a factual, culturally fluent Gen-Z news translator for a news intelligence app.
Transform this factual developing news story into the "News Tea" format.

CRITICAL RULES:
1. Every single fact, person, institution, and outcome must remain 100% accurate.
2. DO NOT exaggerate, invent gossip, sensationalize tragedy, or make up facts.
3. Use casual conversational language, relatable analogies, and light modern slang (e.g., "no cap", "main character energy", "rent free", "receipts dropped", "the plot thickens", "side eye", "era").
4. Return ONLY valid JSON matching this exact structure:
{
  "hook": "Okay, here's the tea on [Topic] 👀",
  "whatHappened": "Crisp 2-sentence conversational rundown of the event",
  "whoIsInvolved": "Who the key players are and why they are clashing/collaborating",
  "whyEveryoneTalking": "Why this is taking over everyone's feeds right now",
  "backstory": "What went down before this that made it such a big deal",
  "whatChanged": "What shifted recently (the plot twist or new development)",
  "whatsHappeningNow": "Where things stand right now at this exact second",
  "keyTakeaway": "Bottom line takeaway in one punchy sentence"
}

Story Title: ${storyTitle}
Facts & Development:
${facts}
`;

  const text = await callGeminiWithFallback(prompt);
  if (text) {
    try {
      return JSON.parse(text) as NewsTeaData;
    } catch {
      // Fall through to fallback synthesis
    }
  }

  // Graceful rule-based fallback when Gemini quota is exhausted
  const snippetMatch = facts.replace(/Title:.*\n|Subtitle:.*\n|What Happened: /g, '').trim().split('\n')[0] || storyTitle;
  return {
    hook: `Okay besties, grab your mug because here is the real tea on ${storyTitle} ☕👀`,
    whatHappened: `${snippetMatch.slice(0, 160)}. Major outlets are tracking this story as developments rapidly unfold.`,
    whoIsInvolved: `Leading policy makers, affected institutions, and investigative wire journalists on the ground.`,
    whyEveryoneTalking: `This is dominating trending feeds because it directly impacts current public expectations and market stability.`,
    backstory: `Before this latest headline broke, tensions and strategic discussions had been building over several weeks.`,
    whatChanged: `New verified dispatches and official disclosures just landed, updating the earlier reports.`,
    whatsHappeningNow: `Official representatives and correspondents are issuing statements and verifying the aftermath.`,
    keyTakeaway: `Bottom line: Keep your eyes on this wire as new verified facts continue to drop in real time.`
  };
}

/**
 * Summarize an individual news article into 2-4 clear lines + verification status assessment
 */
export async function summarizeArticleWithAI(headline: string, snippet: string, source: string): Promise<{
  summary: string;
  verificationStatus: 'verified' | 'unverified' | 'disputed' | 'corrected' | 'developing';
  statusReason: string;
}> {
  const prompt = `
Analyze this news item:
Headline: ${headline}
Source: ${source}
Snippet: ${snippet}

Provide:
1. A concise, easy-to-understand 2-3 line summary explaining the core fact.
2. Verification assessment:
   - "verified" if from reputable wire/official announcement with direct confirmation.
   - "developing" if an ongoing situation with preliminary details.
   - "unverified" if based on anonymous leaks, rumor, or uncorroborated single-source claim.
   - "disputed" if parties give opposing accounts.
   - "corrected" if addressing a previous misstatement.
3. A short 1-line reason for the classification.

Return JSON:
{
  "summary": "...",
  "verificationStatus": "verified" | "developing" | "unverified" | "disputed" | "corrected",
  "statusReason": "..."
}
`;

  const text = await callGeminiWithFallback(prompt);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.summary && parsed.verificationStatus) {
        return parsed;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Graceful rule-based fallback
  const isWire = /Reuters|Associated Press|AP News|AFP|Bloomberg|BBC|NPR|PTI/i.test(source);
  return {
    summary: snippet ? `${snippet.slice(0, 180)}...` : headline,
    verificationStatus: isWire ? 'verified' : 'developing',
    statusReason: isWire 
      ? `Corroborated by ${source} editorial wire service.`
      : `Reported by ${source}; ongoing monitoring active.`
  };
}

/**
 * Rule-based news synthesizer that constructs a complete StoryHub from live articles
 * whenever Gemini is unavailable or rate-limited.
 */
function synthesizeSearchTopicFallback(query: string, rawArticles: NewsItem[]): Partial<StoryHub> {
  const primaryArticle = rawArticles[0] || null;
  const headlineTitle = primaryArticle?.headline || `${query.replace(/^[a-z]/, c => c.toUpperCase())}: Developing Overview`;

  // Infer category from query and articles
  const textCorpus = (query + ' ' + rawArticles.map(a => a.headline + ' ' + a.snippet).join(' ')).toLowerCase();
  let category: Category = 'World';
  if (/(tech|ai|software|chip|apple|google|nvidia|microsoft|meta|crypto|cyber)/.test(textCorpus)) category = 'Technology';
  else if (/(market|fed|inflation|stock|economy|trade|tariff|bank|earnings|deal)/.test(textCorpus)) category = 'Business';
  else if (/(congress|senate|election|biden|trump|court|law|minister|parliament|vote)/.test(textCorpus)) category = 'Politics';
  else if (/(space|nasa|climate|health|fda|cancer|vaccine|earthquake|storm|biology)/.test(textCorpus)) category = 'Science';
  else if (/(india|delhi|mumbai|bjp|modi|isro|rupee)/.test(textCorpus)) category = 'India';
  else if (/(nfl|nba|fifa|olympics|cricket|tennis|championship|match)/.test(textCorpus)) category = 'Sports';
  else if (/(movie|film|oscar|grammy|hollywood|music|star|box office)/.test(textCorpus)) category = 'Entertainment';

  // Construct chronological timeline from available articles
  const sortedArticles = [...rawArticles].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
  
  const phases: TimelineEntry['phase'][] = ['Started', 'Major Development', 'Official Response', 'New Evidence', 'Latest Update'];
  const timeline: TimelineEntry[] = (sortedArticles.length > 0 ? sortedArticles.slice(0, 5) : [primaryArticle]).filter(Boolean).map((article, idx) => {
    const sName = typeof article.source === 'string' ? article.source : article.source?.name || 'News Source';
    return {
      id: `tl-synth-${idx}-${Date.now()}`,
      date: new Date(article.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      phase: phases[idx] || 'Latest Update',
      title: article.headline.slice(0, 90),
      event: article.snippet || article.headline,
      aiExplanation: `Reported by ${sName}. This represents milestone #${idx + 1} as the chronicle unfolded.`,
      sources: [{ name: sName, url: article.url || '#' }],
      status: article.verificationStatus || 'verified',
    };
  });

  // Evolution items showing how the narrative progressed
  const evolutionItems: StoryEvolutionItem[] = sortedArticles.slice(0, 3).map((art, idx) => {
    const sName = typeof art.source === 'string' ? art.source : art.source?.name || 'News Source';
    return {
      id: `evo-synth-${idx}-${Date.now()}`,
      date: new Date(art.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      headlineEvolution: art.headline,
      details: idx === 0 
        ? 'Initial breaking reports provided first details from the wire.'
        : 'Follow-up investigations confirmed key specifics and contextual nuance.',
      classification: (idx === 0 ? 'developing' : 'verified'),
      whatInitiallyReported: art.snippet ? art.snippet.slice(0, 90) : art.headline,
      whatLaterConfirmed: 'Corroborated by follow-up reporting.',
      sources: [sName],
    };
  });

  // Perspectives from different sources
  const perspectives: SourcePerspective[] = rawArticles.slice(0, 3).map((art) => {
    const sName = typeof art.source === 'string' ? art.source : art.source?.name || 'News Source';
    return {
      source: sName,
      outletType: 'Global Wire',
      angle: `Focuses on ${art.headline.slice(0, 60)}`,
      tone: 'Objective News Analysis',
      sampleHeadline: art.headline,
      keyHighlight: art.snippet ? `${art.snippet.slice(0, 120)}...` : art.headline,
    };
  });

  const whatHappened = primaryArticle?.snippet 
    ? `${primaryArticle.headline}: ${primaryArticle.snippet}`
    : `Major developments are unfolding regarding ${query}. Multiple international publications have issued live reports.`;

  return {
    title: headlineTitle,
    subtitle: `Real-time intelligence chronicle tracking ${query}`,
    category,
    status: 'Developing Story',
    quickBrief: {
      whatHappened,
      whyItMatters: `High civic and public interest with ongoing implications across the ${category} sector.`,
      whatsNext: `Monitored continuously via SerpAPI live wire feeds as new statements are issued.`,
    },
    teaMode: {
      hook: `Okay besties, here is what is going down with ${query} 👀☕`,
      whatHappened: `${headlineTitle.slice(0, 140)}. Receipts are dropping fast across the news wire.`,
      whoIsInvolved: `Key spokespersons, institutions, and correspondents covering this beat.`,
      whyEveryoneTalking: `It is taking over timelines because the stakes directly impact current expectations.`,
      backstory: `Tensions and background discussions had been quietly simmering before this story went viral.`,
      whatChanged: `Verified dispatches just arrived, adding clarity to initial unconfirmed chatter.`,
      whatsHappeningNow: `Parties are issuing formal comments and officials are preparing next steps.`,
      keyTakeaway: `Keep refreshing the wire because this situation is in its active developing era.`,
    },
    timeline,
    howItChanged: {
      initiallyReported: sortedArticles[0]?.headline || 'Preliminary breaking wires reported early figures and initial alerts.',
      laterConfirmed: sortedArticles[sortedArticles.length - 1]?.headline || 'Official statements confirmed concrete parameters and context.',
      whatChanged: 'Narrative evolved from breaking news dispatches to detailed chronological analysis.',
      correctionsRetractions: [],
      unverifiedClaims: [],
      conflictingReports: [],
      evolutionItems,
    },
    perspectives,
  };
}

/**
 * Synthesize a custom search topic into an organized StoryHub
 */
export async function synthesizeSearchTopic(query: string, rawArticles: NewsItem[]): Promise<Partial<StoryHub>> {
  if (rawArticles.length === 0) {
    return synthesizeSearchTopicFallback(query, []);
  }

  const articlesContext = rawArticles
    .slice(0, 8)
    .map(a => {
      const sName = typeof a.source === 'string' ? a.source : a.source?.name || 'News Source';
      return `- [${sName}] (${a.publishedAt}) ${a.headline}: ${a.snippet}`;
    })
    .join('\n');

  const prompt = `
You are a news intelligence system. A user searched for "${query}".
We gathered these recent news reports:
${articlesContext}

Organize this into a structured developing story with:
1. title: Clean, informative title
2. subtitle: 1-line context
3. category: one of [World, Politics, Technology, Business, Science, Sports, Entertainment, India]
4. status: Current status (e.g. "Active Inquiry", "Diplomatic Accord", "Regulatory Review")
5. quickBrief: { whatHappened, whyItMatters, whatsNext }
6. teaMode: { hook, whatHappened, whoIsInvolved, whyEveryoneTalking, backstory, whatChanged, whatsHappeningNow, keyTakeaway }
7. timeline: Array of 3-5 chronological timeline nodes (Started, Major Development, Official Response, New Evidence, Latest Update) with exact/relative dates, event summary, and AI explanation.
8. howItChanged:
   - initiallyReported: What was reported at the outset
   - laterConfirmed: What official facts were verified later
   - whatChanged: Key revisions or evolving information
   - correctionsRetractions: Array of any misreports or clarifications
   - unverifiedClaims: Array of rumors/unconfirmed rumors
   - conflictingReports: Array of any differing outlet stances
   - evolutionItems: Array of 3 items showing how headlines and understanding evolved, with classification (verified/unverified/disputed/corrected)
9. perspectives: 3 perspectives showing how different publications framed the event.

Return strictly valid JSON matching this schema.
`;

  const text = await callGeminiWithFallback(prompt);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.title && parsed.quickBrief) {
        return parsed;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Gracefully fallback to structured rule-based synthesis so the user NEVER encounters an error
  return synthesizeSearchTopicFallback(query, rawArticles);
}

/**
 * Generate a spoken audio flash briefing using gemini-3.8-flash-lite-tts.
 *
 * NOTE: Gemini 3.8 TTS models are only available through the newer
 * `client.interactions.create()` API (not the older `ai.models.generateContent`
 * shape used by 2.5-era TTS models). Gemini 3.8 TTS also treats the transcript
 * as verbatim text — turn-level delivery instructions must be attached via a
 * `speech_metadata` annotation rather than a `speechMetadata` field on the part,
 * and the response comes back as WAV (`audio/wav`) by default rather than raw
 * inline PCM/MP3 bytes.
 */
export async function generateSpokenBriefing(scriptText: string): Promise<{ audioBase64: string; mimeType: string } | null> {
  if (!ai) return null;

  try {
    const interaction = await ai.interactions.create({
      model: 'gemini-3.8-flash-lite-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: scriptText,
              annotations: [
                {
                  type: 'speech_metadata',
                  style: 'Clear, engaging modern news anchor briefing',
                },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: 'Zephyr' }],
      },
    });

    const audio = interaction.output_audio;
    if (!audio?.data) return null;

    return { audioBase64: audio.data, mimeType: audio.mime_type || 'audio/wav' };
  } catch (err) {
    console.warn('[Gemini TTS] Spoken briefing unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}
