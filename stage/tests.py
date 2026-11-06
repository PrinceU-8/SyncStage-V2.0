from django.core.files.uploadedfile import SimpleUploadedFile
import json
from django.test import TestCase, Client
from django.urls import reverse
from .models import SongProject, Section, Measure

class SyncStageTests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_root_studio_view_clean_state(self):
        resp = self.client.get(reverse('studio'))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'initial-project-data')
        self.assertContains(resp, 'UNTITLED PROJECT')

    def test_save_and_load_timing_points(self):
        save_payload = {
            "title": "ABBA WORSHIP",
            "key": "E",
            "bpm": 135.0,
            "totalMeasures": 32,
            "beatsPerBar": 4,
            "timingPoints": [
                {"id": 1, "offset": 0.852, "bpm": 135.0, "beatsPerBar": 4},
                {"id": 2, "offset": 45.120, "bpm": 135.0, "beatsPerBar": 4}
            ],
            "sections": [
                {"startBar": 1, "name": "Intro", "color": "#facc15", "isNewSong": True, "songTitle": "ABBA WORSHIP", "songKey": "E"}
            ],
            "measures": [
                {"bar": 1, "chordLine": "E . B .", "leadLine": ""}
            ]
        }

        # 1. Save new project via API
        save_resp = self.client.post(
            reverse('api_save_new'),
            data=json.dumps(save_payload),
            content_type='application/json'
        )
        self.assertEqual(save_resp.status_code, 200)
        project_id = save_resp.json()['projectId']

        # 2. Check timing points in DB
        project = SongProject.objects.get(id=project_id)
        self.assertEqual(len(project.timing_points), 2)
        self.assertEqual(project.timing_points[0]['offset'], 0.852)

        # 3. Check studio_view redirects legacy ID to slug, and slug renders exact timing points
        view_resp = self.client.get(reverse('studio_project', kwargs={'project_id': project_id}), follow=True)
        self.assertEqual(view_resp.status_code, 200)
        self.assertContains(view_resp, '0.852')

        slug_resp = self.client.get(reverse('studio_slug', kwargs={'slug': project.slug}))
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, '0.852')

        # 4. Check load_project_api returns timing points
        api_load_resp = self.client.get(reverse('api_load_project', kwargs={'project_id': project_id}))
        self.assertEqual(api_load_resp.status_code, 200)
        loaded_data = api_load_resp.json()
        self.assertEqual(len(loaded_data['project']['timingPoints']), 2)
        self.assertEqual(loaded_data['project']['timingPoints'][0]['offset'], 0.852)

    def test_delete_project(self):
        project = SongProject.objects.create(title="Delete Me", bpm=120)
        del_resp = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertEqual(del_resp.json()['status'], 'deleted')
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())

    def test_new_project_rendered_and_top_bar_delete_removed(self):
        resp = self.client.get(reverse('studio'))
        self.assertEqual(resp.status_code, 200)
        # Verify New Project button and audio load input exist
        self.assertContains(resp, 'id="btn-new-project"')
        self.assertContains(resp, 'id="audio-file-input"')
        self.assertContains(resp, 'id="new-project-modal"')
        self.assertContains(resp, 'Start New Project')
        self.assertContains(resp, 'id="btn-cancel-new-project"')
        self.assertContains(resp, 'id="btn-discard-new-project"')
        self.assertContains(resp, 'id="btn-save-new-project"')
        # Ensure delete button in top bar has been removed
        self.assertNotContains(resp, 'id="btn-clear-audio"')

    def test_save_project_with_audio_file(self):
        audio_file = SimpleUploadedFile("track.mp3", b"RIFF dummy mp3 audio content", content_type="audio/mpeg")
        payload = {
            "title": "AUDIO SONG",
            "key": "A",
            "bpm": 128.0,
            "totalMeasures": 16,
            "timingPoints": [
                {"id": 1, "offset": 0.0, "bpm": 128.0, "beatsPerBar": 4}
            ],
            "sections": [
                {"startBar": 1, "name": "Verse 1", "color": "#facc15", "isNewSong": True, "songTitle": "AUDIO SONG", "songKey": "A"}
            ],
            "measures": [
                {"bar": 1, "chordLine": "A . . .", "leadLine": ""}
            ]
        }

        save_resp = self.client.post(
            reverse('api_save_new'),
            data={
                'project_data': json.dumps(payload),
                'audio_file': audio_file
            }
        )
        self.assertEqual(save_resp.status_code, 200)
        resp_data = save_resp.json()
        self.assertEqual(resp_data['status'], 'saved')
        self.assertTrue(resp_data.get('audioUrl'))
        self.assertIn('track', resp_data['audioUrl'])

        project_id = resp_data['projectId']
        project = SongProject.objects.get(id=project_id)
        self.assertTrue(project.audio_file)
        self.assertIn('track', project.audio_file.name)

        # Check studio view exposes audioUrl in initial_project_data
        view_resp = self.client.get(reverse('studio_project', kwargs={'project_id': project_id}), follow=True)
        self.assertEqual(view_resp.status_code, 200)
        self.assertContains(view_resp, project.audio_file.url)

        slug_resp = self.client.get(reverse('studio_slug', kwargs={'slug': project.slug}))
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, project.audio_file.url)

        # Check load API returns audioUrl
        load_resp = self.client.get(reverse('api_load_project', kwargs={'project_id': project_id}))
        self.assertEqual(load_resp.status_code, 200)
        self.assertEqual(load_resp.json()['project']['audioUrl'], project.audio_file.url)

        # Clean up uploaded file
        if project.audio_file:
            project.audio_file.delete(save=False)

    def test_upload_audio_api(self):
        project = SongProject.objects.create(title="Upload API Test", bpm=120)
        audio_file = SimpleUploadedFile("direct_upload.mp3", b"dummy audio file data", content_type="audio/mpeg")

        resp = self.client.post(
            reverse('api_upload_audio', kwargs={'project_id': project.id}),
            data={'audio_file': audio_file}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['status'], 'uploaded')
        self.assertTrue(data.get('audioUrl'))

        project.refresh_from_db()
        self.assertTrue(project.audio_file)
        self.assertIn('direct_upload', project.audio_file.name)

        # Clean up
        if project.audio_file:
            project.audio_file.delete(save=False)

    def test_slug_generation_and_redirect(self):
        # 1. Create a project
        p1 = SongProject.objects.create(title="My Awesome Song", bpm=120)
        self.assertEqual(p1.slug, "my-awesome-song")

        # 2. Accessing by numeric ID redirects (302) to slug URL
        id_resp = self.client.get(f"/{p1.id}/")
        self.assertEqual(id_resp.status_code, 302)
        self.assertEqual(id_resp.url, f"/{p1.slug}/")

        # 3. Accessing by slug URL renders directly (200)
        slug_resp = self.client.get(f"/{p1.slug}/")
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, "My Awesome Song")
        self.assertContains(slug_resp, '"projectSlug": "my-awesome-song"')

        # 4. Duplicate title generates unique suffix
        p2 = SongProject.objects.create(title="My Awesome Song", bpm=120)
        self.assertEqual(p2.slug, "my-awesome-song-2")

        # 5. Purely numeric titles get prefixed with 'song-'
        p3 = SongProject.objects.create(title="1999", bpm=120)
        self.assertEqual(p3.slug, "song-1999")

        # 6. Renaming updates slug via save API
        save_resp = self.client.post(
            reverse('api_save_existing_slug', kwargs={'slug': p1.slug}),
            data=json.dumps({"title": "Renamed Track", "totalMeasures": 8}),
            content_type='application/json'
        )
        self.assertEqual(save_resp.status_code, 200)
        resp_json = save_resp.json()
        self.assertEqual(resp_json['slug'], 'renamed-track')
        p1.refresh_from_db()
        self.assertEqual(p1.slug, 'renamed-track')
