const querystring = require("querystring");

import FORMATS from "./formats";
import { getTokens, decipherFormats } from "./sig";
import {
  between,
  stripHTML,
  parallel,
  addFormatMeta,
  sortFormats
} from "./util";
import {
  getAuthor,
  getPublished,
  getVideoDescription,
  getVideoMedia,
  getRelatedVideos
} from "./info-extras";

const VIDEO_URL = "https://www.youtube.com/watch?v=";
const EMBED_URL = "https://www.youtube.com/embed/";
const VIDEO_EURL = "https://youtube.googleapis.com/v/";
const INFO_HOST = "www.youtube.com";
const INFO_PATH = "/get_video_info";
const KEYS_TO_SPLIT = ["keywords", "fmt_list", "fexp", "watermark"];

/**
 * Gets info from a video without getting additional formats.
 *
 * @param {string} id
 * @param {Object} options
 * @param {Function(Error, Object)} callback
 */
export const getBasicInfo = (id, options, callback) => {
  // Try getting config from the video page first.
  const params = "hl=" + (options.lang || "en");
  let url =
    VIDEO_URL + id + "&" + params + "&bpctr=" + Math.ceil(Date.now() / 1000);

  // Remove header from watch page request.
  // Otherwise, it'll use a different framework for rendering content.
  const reqOptions = Object.assign({}, options.requestOptions);
  reqOptions.headers = Object.assign({}, reqOptions.headers, {
    "User-Agent": ""
  });

  fetch(url)
    .then(body => body.text())
    .then(body => {
      console.log("body: " + body.length);

      err = null;
      res = null;

      // Check if there are any errors with this video page.
      const unavailableMsg = between(body, '<div id="player-unavailable"', ">");
      if (
        unavailableMsg &&
        !/\bhid\b/.test(between(unavailableMsg, 'class="', '"'))
      ) {
        // Ignore error about age restriction.
        if (!body.includes('<div id="watch7-player-age-gate-content"')) {
          return callback(
            Error(
              between(
                body,
                '<h1 id="unavailable-message" class="message">',
                "</h1>"
              ).trim()
            )
          );
        }
      }

      // Parse out additional metadata from this page.
      const additional = {
        // Get the author/uploader.
        author: getAuthor(body),

        // Get the day the vid was published.
        published: getPublished(body),

        // Get description.
        description: getVideoDescription(body),

        // Get media info.
        media: getVideoMedia(body),

        // Get related videos.
        related_videos: getRelatedVideos(body),

        // Give the standard link to the video.
        video_url: VIDEO_URL + id
      };

      const jsonStr = between(body, "ytplayer.config = ", "</script>");
      let config;
      if (jsonStr) {
        config = jsonStr.slice(0, jsonStr.lastIndexOf(";ytplayer.load"));
        gotConfig(id, options, additional, config, false, callback);
      } else {
        // If the video page doesn't work, maybe because it has mature content.
        // and requires an account logged in to view, try the embed page.
        url = EMBED_URL + id + "?" + params;

        fetch(url)
          .then(body => body.text())
          .then(body => {
            if (err) return callback(err);
            config = between(
              body,
              "t.setConfig({'PLAYER_CONFIG': ",
              /\}(,'|\}\);)/
            );
            gotConfig(id, options, additional, config, true, callback);
          })
          .catch(err => console.error(err));
      }
    })
    .catch(error => console.error(error));
};

export const gotConfig = (
  id,
  options,
  additional,
  config,
  fromEmbed,
  callback
) => {
  if (!config) {
    return callback(Error("Could not find player config"));
  }
  try {
    config = JSON.parse(config + (fromEmbed ? "}" : ""));
  } catch (err) {
    return callback(Error("Error parsing config: " + err.message));
  }

  fetch(
    "https://" +
      INFO_HOST +
      INFO_PATH +
      "?" +
      querystring.stringify({
        video_id: id,
        eurl: VIDEO_EURL + id,
        ps: "default",
        gl: "US",
        hl: "en",
        sts: config.sts
      })
  )
    .then(body => body.text())
    .then(body => {
      // console.log("Got response: "+body.length )

      let info = querystring.parse(body);
      // console.log('info: ' + JSON.stringify(info)  )

      if (info.status === "fail") {
        if (
          config.args &&
          (config.args.fmt_list ||
            config.args.url_encoded_fmt_stream_map ||
            config.args.adaptive_fmts)
        ) {
          info = config.args;
          info.no_embed_allowed = true;
        } else {
          return callback(
            Error(`Code ${info.errorcode}: ${stripHTML(info.reason)}`)
          );
        }
      }

      const player_response =
        config.args.player_response || info.player_response;
      if (player_response) {
        try {
          info.player_response = JSON.parse(player_response);
        } catch (err) {
          return callback(
            Error("Error parsing `player_response`: " + err.message)
          );
        }
        let playability = info.player_response.playabilityStatus;
        if (playability && playability.status === "UNPLAYABLE") {
          return callback(Error(playability.reason));
        }
      }

      // Split some keys by commas.
      KEYS_TO_SPLIT.forEach(key => {
        if (!info[key]) return;
        info[key] = info[key].split(",").filter(v => v !== "");
      });

      info.fmt_list = info.fmt_list
        ? info.fmt_list.map(format => format.split("/"))
        : [];

      info.formats = parseFormats(info);

      // Add additional properties to info.
      Object.assign(info, additional);
      info.age_restricted = fromEmbed;
      info.html5player = config.assets.js;
      if (config.args.dashmpd && info.dashmpd !== config.args.dashmpd) {
        info.dashmpd2 = config.args.dashmpd;
      }

      callback(null, info);
    })
    .catch(err => console.error(err));
};
export const getFullInfo = (id, options, callback) => {
  return getBasicInfo(id, options, (err, info) => {
    if (err) return callback(err);

    if (info.formats.length || info.dashmpd || info.dashmpd2 || info.hlsvp) {
      const html5playerfile = "https://" + INFO_HOST + info.html5player;
      // console.log("html5playerfile: "+html5playerfile)
      getTokens(html5playerfile, options, (err, tokens) => {
        if (err) return callback(err);

        // console.log("info.formats: "+JSON.stringify(info.formats))
        decipherFormats(info.formats, tokens, options.debug);
        // console.log("after info.formats: "+JSON.stringify(info.formats))

        let funcs = [];

        if (info.dashmpd) {
          info.dashmpd = decipherURL(info.dashmpd, tokens);
          funcs.push(getDashManifest.bind(null, info.dashmpd, options));
        }

        if (info.dashmpd2) {
          info.dashmpd2 = decipherURL(info.dashmpd2, tokens);
          funcs.push(getDashManifest.bind(null, info.dashmpd2, options));
        }

        if (info.hlsvp) {
          info.hlsvp = decipherURL(info.hlsvp, tokens);
          funcs.push(getM3U8.bind(null, info.hlsvp, options));
        }

        parallel(funcs, (err, results) => {
          if (err) return callback(err);
          if (results[0]) {
            mergeFormats(info, results[0]);
          }
          if (results[1]) {
            mergeFormats(info, results[1]);
          }
          if (results[2]) {
            mergeFormats(info, results[2]);
          }
          if (!info.formats.length) {
            callback(Error("No formats found"));
            return;
          }

          if (options.debug) {
            info.formats.forEach(format => {
              const itag = format.itag;
              if (!FORMATS[itag]) {
                console.warn(`No format metadata for itag ${itag} found`);
              }
            });
          }

          info.formats.forEach(addFormatMeta);
          info.formats.sort(sortFormats);
          info.full = true;
          callback(null, info);
        });
      });
    } else {
      callback(Error("This video is unavailable"));
    }
  });
};

export const parseFormats = info => {
  let formats = [];
  if (info.url_encoded_fmt_stream_map) {
    formats = formats.concat(info.url_encoded_fmt_stream_map.split(","));
  }
  if (info.adaptive_fmts) {
    formats = formats.concat(info.adaptive_fmts.split(","));
  }

  formats = formats.map(format => querystring.parse(format));
  delete info.url_encoded_fmt_stream_map;
  delete info.adaptive_fmts;

  return formats;
};
