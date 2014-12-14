/*jslint unparam:true*/
"use strict";
var request = require('request');
var formdata = require('form-data');
var cheerio = require('cheerio');
var querystring = require('querystring');

var URL_BASE = "https://real-debrid.com/";
var URL_API = URL_BASE + "api/"
var URL_AJAX = URL_BASE + "ajax/"

var DOWNLOAD_TORRENT_LIMIT = 5;

/**
 * Prepare the request to save cookies.
 */
request = request.defaults({
    jar: true,
    encoding: 'utf-8',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.13) Gecko/20080311 Firefox/2.0.0.13'
    }
});

var validHostersCached = [];

/**
 * Get all valid hoster.
 * @param fn the callback(error, data).
 * @returns {*}
 */
var getValidHosters = function (fn) {
    if (validHostersCached.length > 0) {
        return fn(null, validHostersCached);
    }
    request({
        url: URL_API + 'hosters.php'
    }, function (err, reponse, body) {
        if (err) {
            return fn(err, []);
        }
        validHostersCached = body.substring(1, body.length - 1).split('","');
        fn(err, validHostersCached);
    });
};
exports.getValidHosters = getValidHosters;

/**
 * Login to real debrid.
 * @param user the username.
 * @param pass the password.
 * @param fn the callback(error).
 */
var login = function (user, pass, fn) {
    request({
        url: URL_AJAX + 'login.php?user=' + user + '&pass=' + pass,
        json: true
    }, function (err, reponse, data) {
        if (err) {
            if (fn) {
                fn(err);
            }
        } else {
            if (data.error === 0) {
                if (fn) {
                    fn(null);
                }
            } else if (fn) {
                var error = new Error(data.message);
                error.code = data.error;
                fn(error);
            }
        }
    });
};
exports.login = login;

/**
 * Get informations about the account.
 * @param fn the callback(error, data).
 */
var account = function (fn) {
    request({
        url: URL_API + 'account.php?out=json',
        json: true
    }, function (err, reponse, data) {
        if (data.error === 1) {
            var error = new Error(data.message);
            error.code = data.error;
            fn(error, null);
        } else {
            fn(null, data);
        }
    });
};
exports.account = account;

/**
 * Unrestrict a link.
 * @param link the link to debrid.
 * @param password the eventual password.
 * @param fn the callback(error, data).
 */
var unrestrict = function (link, password, fn) {
    link = encodeURI(link);

    if (!fn || typeof fn !== 'function') {
        fn = password;
        password = '';
    }

    request({
        url: URL_AJAX + 'unrestrict.php?out=json&link=' + link + '&password=' + password,
        json: true
    }, function (err, reponse, data) {
        if (err) {
            return fn(err, null);
        }
        if (data.error > 0) {
            var error = new Error(data.message);
            error.code = data.error;
            fn(error, null);
        } else {
            fn(null, data);
        }
    });
};
exports.unrestrict = unrestrict;

/**
 * Add a torrent to download.
 * @param magnetLink the magnet link corresponding to the torrent.
 * @param fileExtensionFilter the array of file extension to download.
 * @param callback the callback.
 */
var downloadTorrent = function(magnetLink, fileExtensionFilter, callback){

    checkDownloadRestrictions(function(error) {

        if(error){
            if(callback) return callback(error);
            else return;
        }

        // Prepare multipart form data.
        var form = new formdata();
        form.append('file', new Buffer(0), {
            'filename': '\0',
            'contentType': 'application/octet-stream'
        });
        form.append("magnet", magnetLink);
        form.append('splitting_size', 50, {});
        form.append('hoster', '1f', {});

        // Send the request.
        var r = request.post(URL_BASE + "torrents", function (err, res, body) {
            var $ = cheerio.load(body);

            $("td:first-child.t-left").each(function (i, element) {

                var fileId = $(this).find("span[id^=name_]").attr('id').split("_")[1];
                var warning = $(this).find("img[alt=Warning]");
                var warningMessage = warning.parent().text();
                var torrentId = $(this).next().find("a[id^=link_]").attr('id').split("_")[1];

                // Start torrent on "choose file" status.
                if (warningMessage && warningMessage.indexOf('choose the files') > -1) {
                    selectFiles(torrentId, fileExtensionFilter, function (err, result) {
                        launchFilesDownload(result, function (err) {
                            if (callback) {
                                if (err) {
                                    return callback(err);
                                }
                                return callback(err, {id: fileId, torrentId: torrentId});
                            }
                        })
                    });
                }
            });
        });
        r._form = form;
    });
};
exports.downloadTorrent = downloadTorrent;

/**
 * Select the files to download.
 * @param torrentId the torrentId to analyse.
 * @param fileExtensionFilter array of format to select for download.
 * @param callback the callback(error, data).
 */
function selectFiles(torrentId, fileExtensionFilter, callback){

    if(torrentId) {
        // Analyse the torrents HTML page
        request.get(URL_AJAX + "torrent_files.php?id=" + torrentId, function (err, res, body) {

            // If error
            if (err) {
                if(callback) return callback(err);
                else return;
            }

            // Else analyse the returned page
            var $ = cheerio.load(body);
            var result = {
                torrentId: torrentId
            };

            // Search files
            var addedFileNumber = [];
            $("span.px10").each(function (i, element) {
                // Get the file name
                var filename = $(this).html();

                if (fileExtensionFilter) {
                    // Check if the file matches a file format
                    fileExtensionFilter.every(function (element, j) {
                        var endsWith = filename.indexOf(element, filename.length - element.length) !== -1;
                        if (!endsWith) {
                            if (!result.files_unwanted) {
                                result.files_unwanted = i + 1;
                            } else if (addedFileNumber.indexOf(i + 1) == -1) {
                                result.files_unwanted = result.files_unwanted + "," + (i + 1);
                            }
                            addedFileNumber.push(i + 1);
                            return true;
                        }
                        return false;
                    });
                }
            });


            // Result
            if (callback) {
                return callback(null, result);
            }
        });
    } else {
       if(callback) return callback("No downloads found");
    }
}

/**
 * Launch the download of the specified file.
 * @param filesToDownload the file to download.
 * @param callback the callback.
 */
function launchFilesDownload(filesToDownload, callback){

        // Analyse filesToDownload
        if (!filesToDownload || !filesToDownload.torrentId || !filesToDownload.files_unwanted)
            if (callback) return callback("No file to download")
            else return;

        // Prepare parameters for the request.
        var parameters = {
            files_unwanted: filesToDownload.files_unwanted,
            start_torrent: '1'
        }

        // Launch the download
        request.post({
                url: URL_AJAX + "torrent_files.php?id=" + filesToDownload.torrentId,
                headers: {
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body: querystring.stringify(parameters)
            },
            function (err, res, body) {
                if (err) {
                    return callback("Error while start download " + filesToDownload.torrentId);
                }
                return callback();
            });

}

/**
 * Check the download restrictions
 * @param callback the callback(error).
 */
function checkDownloadRestrictions(callback){
    // Check if the limit is not crossed
    getTorrentsStatus(function(err, result) {
        if(result.total >= DOWNLOAD_TORRENT_LIMIT){
            if (callback) return callback("Limit of " + DOWNLOAD_TORRENT_LIMIT + " downloads exceeded")
            else return;
        }
        callback();
    });
}

/**
 * Get all torrent status.
 * @param callback the callback(error, data).
 **/
function getTorrentsStatus(callback) {
    request(URL_AJAX + "torrent.php?action=status_a&p=1", function (err, response, body) {
        if (callback) return callback(err, JSON.parse(body));
    });
}
exports.getTorrentsStatus = getTorrentsStatus;

/**
 * Get a torrent status.
 * @param callback the callback(error, data).
 **/
function getTorrentStatus(id, callback) {
    if(id) {
        request(URL_AJAX + "torrent.php?action=status_a&p=1", function (err, response, body) {
            if (body) {
                var array = JSON.parse(body);
                //filter by torrent id
                array.list.forEach(function (element, i) {
                    if (element.id == id) {
                        if (callback) return callback(null, element);
                        else return;
                    }
                });
            } else {
                if (callback) return callback("No status found for " + id);
            }
        });
    } else {
        if (callback) return callback("No status found for " + id);
    }
}
exports.getTorrentStatus = getTorrentStatus;


/**
 * Delete the torrent from the list.
 * @param id the file ID to delete.
 * @param callback the callback(error, result).
 */
function deleteTorrentById(id, callback) {
    if (id) {
        getTorrentIdById(id, function (err, result) {
            if (!err) {
                deleteTorrentByTorrentId(result, function (err, body) {
                    if (callback) return callback(err, body);
                })
            } else {
                if(callback) return callback("Cannot delete torrent with file ID : " + id);
            }
        });
    } else {
        if(callback) return callback("Cannot delete torrent with file ID : " + id);
    }
}
exports.deleteTorrentById = deleteTorrentById;

/**
 * Delete the torrent from the list.
 * @param torrentId the torrent ID to delete.
 * @param callback the callback(error, result).
 */
function deleteTorrentByTorrentId(torrentId, callback){
    if(torrentId) {
        // Check if the torrent ID exists on the page
        request(URL_BASE + "torrents", function (err, res, body) {
            var torrentIdExists = body.indexOf(torrentId) != -1
            if (torrentIdExists) {
                request('https://real-debrid.com/torrents?p=1&del=' + torrentId, function (err, response, body) {
                    if (callback) return callback(err, body);
                });
            } else {
                return callback("Torrent does not exist : " + torrentId);
            }
        });
    } else {
        return callback("Cannot delete torrent with torrent ID : " + torrentId);
    }
}
exports.deleteTorrentByTorrentId = deleteTorrentByTorrentId;

/**
 * Get the torrend ID according a file id.
 * @param id the id of the file
 * @param callback the callback(result).
 */
function getTorrentIdById(id, callback){
    if(id) {
        // Send the request.
        request(URL_BASE + "torrents", function (err, res, body) {
            if(!err) {
                var $ = cheerio.load(body);
                $("td[id^=delete_" + id + "] a").each(function (i, element) {
                    var url = element.attribs.href;
                    var startsWith = url.indexOf("?p=1&del=", 0) !== -1;
                    if (startsWith) {
                        if (callback) callback(null, url.replace("?p=1&del=", ""));
                        return;
                    }
                });
                if(callback) return callback("Cannot find torrent ID from ID : " + id);
            }
        });
    } else {
        if(callback) return callback("Cannot find torrent ID from ID : " + id);
    }
}

login('raidow', 'dirbed', function() {
    deleteTorrentByTorrentId("F5IPFUK5ACMJE", function(err, result){
       console.log(!err ? 'OK' : 'KO');
    });
});